-- Migration 064: triage the unknown-trust backlog with deterministic provenance rules.
-- Ref: 2026-07-22 daily research Tier 2; migration 041 (derive_trust_tier),
--      migration 061 (trust lane in hybrid_recall).
--
-- THE PROBLEM
--   284 of 795 rows (35.7%) sit at trust_tier='unknown'. Migration 061 shipped
--   the trust lane as a SOFT down-weight only, explicitly because a hard
--   quarantine floor applied while a third of the corpus is un-triaged would
--   silently drop that third out of recall. So 'unknown' is not just cosmetic —
--   it is the thing blocking the stronger trust policy.
--
-- WHY THE BACKLOG EXISTS (this is the actual bug, not a data-entry gap)
--   derive_trust_tier(source) is a CASE over EXACT source strings: 'claude-code',
--   'wren', 'forge', 'atlas', 'claude-ai', 'iris', 'volt', 'hermes', 'manual'.
--   Anything else falls to 'unknown'. But almost nothing in this system writes
--   with a bare agent name. Actual sources of the 284 unknown rows:
--     ai-memory-research-trigger        111  (writer_agent=wren)
--     cowork                             66  (writer_agent=iris)
--     consolidation                      43  (writer_agent=wren)
--     dreaming_consolidate               24  (writer_agent=wren)
--     wren-constitution-auditor          12  (writer_agent=wren)
--     wren-claude-code                    6  (writer_agent=wren)
--     ...plus ~20 one-off sources, nearly all <agent>-<something>
--   283 of the 284 carry a non-NULL writer_agent. These rows are not
--   unattributed; the deriving function simply had no rule for a compound
--   source string. 'unknown' here means "the CASE didn't match", not
--   "provenance is doubtful" — exactly what migration 061's comment suspected.
--
-- THE RULE (deterministic, no judgment calls, no LLM)
--   1. Exact source match  -> existing tier (unchanged; verified/high/medium)
--   2. Otherwise, if the row is attributable — the source is prefixed with a
--      known first-party agent, or writer_agent names one -> 'medium'
--   3. Otherwise (no agent prefix AND no writer_agent) -> 'low'
--
--   Deliberately conservative: attributable-but-indirect rows land at 'medium'
--   (weight 0.95), NOT 'high'. A bare source of 'wren' means the Wren agent
--   wrote it directly; 'ai-memory-research-trigger' means an automated pipeline
--   Wren operates produced it, and nobody vouched for the output. One tier of
--   separation between "an agent wrote this" and "an automation emitted this"
--   is the honest encoding, and it costs almost nothing in recall (0.90 -> 0.95).
--
--   Net effect: unknown 284 -> 1. That is what unblocks reassessing a hard
--   quarantine floor, which is the point of the exercise. See the closing
--   NOTICE for the post-triage distribution and the floor recommendation.

-- ── 1. Provenance-aware overload ─────────────────────────────────────────────
-- New 2-arg form. The 1-arg form is kept and delegates, so any existing caller
-- (and the injection-scan trigger's old signature) keeps working.
CREATE OR REPLACE FUNCTION public.derive_trust_tier(p_source text, p_writer_agent text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    -- 1. Exact, direct-write sources — unchanged from migration 041.
    WHEN lower(coalesce(p_source, '')) = 'manual'      THEN 'verified'
    WHEN lower(coalesce(p_source, '')) = 'claude-code' THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'wren'        THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'forge'       THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'atlas'       THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'claude-ai'   THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'iris'        THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'volt'        THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'hermes'      THEN 'medium'

    -- 2. Attributable but indirect: a first-party agent appears as a source
    --    prefix, or writer_agent names one. Automation run by a known agent.
    WHEN lower(coalesce(p_source, '')) ~
         '^(wren|iris|atlas|forge|volt|hermes|cowork|claude-code|claude-ai|dispatch)([-_].*)?$'
      THEN 'medium'
    WHEN lower(coalesce(p_writer_agent, '')) ~
         '^(wren|iris|atlas|forge|volt|hermes|cowork|claude-code|claude-ai|dispatch)([-_].*)?$'
      THEN 'medium'

    -- 3. No agent prefix, no writer_agent: an unattributed direct write.
    WHEN coalesce(nullif(trim(p_writer_agent), ''), '') = '' THEN 'low'

    -- 4. writer_agent set but not a recognised agent — attributable to
    --    *something*, just not to us. Below medium, above unattributed.
    ELSE 'low'
  END;
$$;

COMMENT ON FUNCTION public.derive_trust_tier(text, text) IS
  'Provenance-based trust tier (migration 064). Exact agent source -> verified/high/medium (migration 041 table, unchanged); <agent>-<pipeline> source or a recognised writer_agent -> medium (attributable but nobody vouched); neither -> low. Deterministic, source-driven, no LLM. Consumed by hybrid_recall via trust_weight() (migration 061).';

-- Keep the 1-arg signature working; it now simply has no writer_agent to use.
CREATE OR REPLACE FUNCTION public.derive_trust_tier(p_source text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.derive_trust_tier(p_source, NULL);
$$;

COMMENT ON FUNCTION public.derive_trust_tier(text) IS
  'Back-compat 1-arg form (migration 041, rewritten by 064) — delegates to derive_trust_tier(source, writer_agent) with no writer_agent. Prefer the 2-arg form: without writer_agent, compound sources that are attributable can only be judged by their prefix.';

-- ── 2. Teach the write-path trigger to pass writer_agent ─────────────────────
-- scan_memory_for_injection() derives trust_tier on every write. It was calling
-- the 1-arg form, so every compound source was landing at 'unknown' on INSERT —
-- i.e. the backlog would rebuild itself even after a backfill. Patch in place
-- for the same reason 061/063 patch hybrid_recall in place: the function body
-- is long and mostly unrelated (injection scanning), and retyping it to change
-- one call is the higher-risk edit.
DO $patch$
DECLARE
  v_def  text;
  v_old  text := 'new.trust_tier := public.derive_trust_tier(new.source);';
  v_new  text := 'new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);';
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 064: scan_memory_for_injection not found';
  END IF;

  IF position('derive_trust_tier(new.source, new.writer_agent)' in v_def) > 0 THEN
    RAISE NOTICE 'migration 064: trigger already provenance-aware, skipping patch';
    RETURN;
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'migration 064: expected exactly 1 derive_trust_tier call site in the trigger, found % — drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
  RAISE NOTICE 'migration 064: injection-scan trigger now derives trust_tier from (source, writer_agent)';
END
$patch$;

-- ── 3. Backfill ──────────────────────────────────────────────────────────────
-- Only rows the old CASE could not classify. Rows already at verified/high/
-- medium were derived by an exact match and are not revisited.
DO $backfill$
DECLARE
  v_before integer;
  v_after  integer;
  v_dist   text;
BEGIN
  SELECT count(*) INTO v_before
  FROM memories WHERE COALESCE(trust_tier, 'unknown') = 'unknown';

  UPDATE memories m
  SET trust_tier = public.derive_trust_tier(m.source, m.writer_agent)
  WHERE COALESCE(m.trust_tier, 'unknown') = 'unknown';

  SELECT count(*) INTO v_after
  FROM memories WHERE COALESCE(trust_tier, 'unknown') = 'unknown';

  SELECT string_agg(t || '=' || c, ' ' ORDER BY c DESC) INTO v_dist
  FROM (SELECT COALESCE(trust_tier, 'unknown') t, count(*) c
        FROM memories GROUP BY 1) s;

  RAISE NOTICE 'migration 064: unknown % -> %; distribution now: %', v_before, v_after, v_dist;
  RAISE NOTICE 'migration 064: HARD QUARANTINE FLOOR — still NOT enabled. The backlog is '
               'cleared, but every triaged row landed at medium (0.95), so a floor at '
               'medium would exclude nothing and a floor above it would exclude ~35%% of '
               'the corpus. Revisit only once ''low''/''quarantined'' are populated by an '
               'actual distrust signal (injection hits, failed verification), not by the '
               'absence of a CASE arm.';
END
$backfill$;
