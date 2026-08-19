-- 124_trust_tier_provenance_cap.sql — 2026-08-19 research impl 1/4.
--
-- DECISION ENFORCED: 122 said "writers MAY downgrade but NOT upgrade".
--                    The shipped trigger only ever implemented the first half.
--
-- WHAT 122/123 ACTUALLY SHIPPED
--   122 replaced the unconditional assignment with coalesce(); 123 fixed the
--   DEFAULT='unknown' hole, leaving:
--
--     new.trust_tier := case
--       when new.trust_tier is null or new.trust_tier = 'unknown'
--         then public.derive_trust_tier(new.source, new.writer_agent)
--       else new.trust_tier
--     end;
--
--   There is no rank comparison anywhere in that expression. 122's header
--   asserts "No upgrade pathway exists in the trigger" — that was a claim
--   about intent, never a check. Any explicit non-'unknown' value is taken
--   verbatim, in EITHER direction.
--
-- MEASURED 2026-08-19 (probe inserted, then reverted)
--   source = writer_agent = 'dreaming_consolidate'  (derive_trust_tier -> 'low')
--   INSERT ... trust_tier = 'high'                  -> STORED AS 'high'
--   No error. No notice. No memory_log entry recording the elevation.
--   The downgrade direction was confirmed working in the same probe.
--
-- WHY THIS MATTERS
--   trust_weight(trust_tier) is an OUTER MULTIPLIER on hybrid_recall fusion,
--   so tier directly controls ranking: 'high' = 1.00 vs 'low' = 0.75. Any
--   writer that can set its own tier can buy itself a permanent 33% ranking
--   premium over what its provenance warrants.
--
--   dreaming_consolidate is the sharp case: an automated summarizer, running
--   unattended, writing rows derived from other rows. arXiv 2606.24322
--   (TMA-NM) shows summarization is a laundering channel — the summary of a
--   low-trust source presents as clean, novel prose, so neither content
--   inspection nor lineage tracing recovers the original trust level. Their
--   conclusion is that trust must be bound at WRITE TIME from origin, and any
--   elevation must be corroboration-gated rather than self-asserted.
--   arXiv 2606.22030 names the shape this migration implements:
--   provenance-CAPPED — the writer's claim is an upper bound request, and
--   provenance is the ceiling.
--
-- THE FIX
--   Two new helpers, and one line changed in the trigger.
--
--   1. trust_tier_rank(text) -> integer — the ordering that was missing:
--        quarantined(0) < low(1) < medium(2) < high(3) < verified(4)
--      'unknown' and any unrecognised string rank NULL, which reads as
--      "no opinion / please derive". There is no CHECK constraint on
--      memories.trust_tier, so unrecognised values are reachable and must
--      fail toward provenance rather than toward the writer.
--
--   2. cap_trust_tier(requested, derived) -> text:
--        rank(requested) IS NULL            -> derived   (please-derive)
--        rank(requested) <= rank(derived)   -> requested (downgrade honoured)
--        otherwise                          -> derived   (elevation CAPPED)
--
--   Preserved from 123: NULL and 'unknown' both still mean "please derive",
--   so the column DEFAULT keeps working and no caller has to change.
--   Preserved from 122: a writer that knows its own evidence is weak can
--   still say so, and is still believed. Self-quarantine ranks 0, so
--   trust_tier='quarantined' is a downgrade and is always honoured.
--
--   NOT CHANGED: derive_trust_tier itself. The provenance table is the
--   ceiling being enforced here; re-litigating it is a separate decision.
--
--   Minor: the honoured branch returns lower(trim(requested)). trust_weight
--   matches tier strings exactly, so 'HIGH' would previously have been
--   stored and then silently scored at the 0.90 fallback. Normalising is
--   strictly closer to the intended weight for already-valid input.
--
-- ORDERING
--   This runs FIRST in the trigger, exactly where the old assignment was.
--   The soft-signal quarantine block still runs AFTER and still overrides
--   unconditionally — an injection hit caps a 'verified' row to
--   'quarantined' regardless of what the cap decided. That is deliberate:
--   the provenance cap is a ceiling, the quarantine cap is a floor-stomp.

-- ---------------------------------------------------------------------------
-- 1. The ordering helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trust_tier_rank(p_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE lower(trim(coalesce(p_tier, '')))
    WHEN 'quarantined' THEN 0
    WHEN 'low'         THEN 1
    WHEN 'medium'      THEN 2
    WHEN 'high'        THEN 3
    WHEN 'verified'    THEN 4
    ELSE NULL            -- 'unknown', '', NULL, or anything unrecognised
  END::integer;
$fn$;

COMMENT ON FUNCTION public.trust_tier_rank(text) IS
  'Total order over trust_tier: quarantined(0) < low(1) < medium(2) < high(3) < verified(4). Returns NULL for ''unknown'', empty, or unrecognised input — callers must read NULL as "no opinion", never as "lowest". Added by migration 124.';

-- ---------------------------------------------------------------------------
-- 2. The cap: a writer-supplied tier may only lower the derived tier.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cap_trust_tier(p_requested text, p_derived text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
    -- NULL / 'unknown' / unrecognised: the writer expressed no usable
    -- opinion. Fall back to provenance (this is the 123 behaviour).
    WHEN public.trust_tier_rank(p_requested) IS NULL
      THEN p_derived
    -- At or below what provenance warrants: the writer knows its own
    -- evidence quality better than the identity table does. Honour it.
    WHEN public.trust_tier_rank(p_requested) <= public.trust_tier_rank(p_derived)
      THEN lower(trim(p_requested))
    -- Above what provenance warrants: capped. Self-assertion is not evidence.
    ELSE p_derived
  END;
$fn$;

COMMENT ON FUNCTION public.cap_trust_tier(text, text) IS
  'Provenance cap for trust_tier (migration 124, enforcing migration 122''s stated decision). Returns the writer-requested tier only when it is at or below the provenance-derived tier; otherwise returns the derived tier. NULL/''unknown''/unrecognised requests derive. Downgrades — including self-quarantine — are always honoured. See arXiv 2606.22030 (provenance-capped trust) and 2606.24322 (summarization as a trust-laundering channel).';

-- ---------------------------------------------------------------------------
-- 3. Patch the one line in scan_memory_for_injection().
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def  text;
  v_old  text := 'new.trust_tier := case when new.trust_tier is null or new.trust_tier = ''unknown'' then public.derive_trust_tier(new.source, new.writer_agent) else new.trust_tier end;';
  v_new  text := 'new.trust_tier := public.cap_trust_tier(new.trust_tier, public.derive_trust_tier(new.source, new.writer_agent));';
  v_oldc text := '-- Provenance-derived tier first; the soft-signal block below may cap it.';
  v_newc text := '-- Provenance-CAPPED tier first (124): a writer may lower it, never raise'
              || E'\n  -- it. The soft-signal block below may still cap it further.';
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 124: scan_memory_for_injection not found';
  END IF;

  IF position('public.cap_trust_tier(new.trust_tier' in v_def) > 0 THEN
    RAISE NOTICE 'migration 124: trigger already provenance-capped, skipping patch';
    RETURN;
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'migration 124: expected exactly 1 post-123 trust_tier assignment in the trigger, found % — drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(replace(v_def, v_old, v_new), v_oldc, v_newc);
  RAISE NOTICE 'migration 124: scan_memory_for_injection now caps writer-supplied trust_tier at the derived tier';
END
$patch$;

COMMENT ON FUNCTION public.scan_memory_for_injection() IS
  'Memory write-path injection guard (migrations 041->093) with provenance-capped writer authority (122 intent, 123 unknown-default fix, 124 enforcement). trust_tier := cap_trust_tier(writer_requested, derive_trust_tier(source, writer_agent)) — writers may downgrade, never upgrade; NULL/''unknown'' derive. Soft-signal quarantine still overrides afterwards. See [[writer-authority-vs-evidence-downgrade]] and [[trust-tier-is-provenance-capped-migration-124]].';

-- ---------------------------------------------------------------------------
-- 4. VERIFY — both directions, against the real table, residue removed.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_up_tier   text;
  v_down_tier text;
  v_up_id     uuid;
  v_down_id   uuid;
  v_msg       text;
BEGIN
  -- Static check first: the helpers must agree with the decision on their own.
  IF public.cap_trust_tier('high', 'low')      IS DISTINCT FROM 'low'  THEN
    RAISE EXCEPTION 'migration 124: cap_trust_tier(high, low) should cap to low';
  END IF;
  IF public.cap_trust_tier('low', 'high')      IS DISTINCT FROM 'low'  THEN
    RAISE EXCEPTION 'migration 124: cap_trust_tier(low, high) should honour the downgrade';
  END IF;
  IF public.cap_trust_tier('unknown', 'high')  IS DISTINCT FROM 'high' THEN
    RAISE EXCEPTION 'migration 124: cap_trust_tier(unknown, high) should derive';
  END IF;
  IF public.cap_trust_tier(NULL, 'medium')     IS DISTINCT FROM 'medium' THEN
    RAISE EXCEPTION 'migration 124: cap_trust_tier(NULL, medium) should derive';
  END IF;
  IF public.cap_trust_tier('bogus', 'low')     IS DISTINCT FROM 'low'  THEN
    RAISE EXCEPTION 'migration 124: unrecognised request must fall back to derived';
  END IF;
  IF public.cap_trust_tier('quarantined', 'verified') IS DISTINCT FROM 'quarantined' THEN
    RAISE EXCEPTION 'migration 124: self-quarantine is a downgrade and must be honoured';
  END IF;

  -- Live check: the trigger is what actually runs, so probe the real table.
  BEGIN
    -- Direction 1 (the bug): low-provenance writer asks for 'high'.
    -- source/writer_agent 'dreaming_consolidate' derives 'low'.
    INSERT INTO memories (type, name, description, content, source, writer_agent, trust_tier)
    VALUES ('reference', '__mig124_probe_elevate', 'migration 124 verify probe',
            'migration 124 verify probe row', 'dreaming_consolidate', 'dreaming_consolidate', 'high')
    RETURNING id, trust_tier INTO v_up_id, v_up_tier;

    -- Direction 2 (must keep working): high-provenance writer asks for 'low'.
    -- source/writer_agent 'wren' derives 'high'.
    INSERT INTO memories (type, name, description, content, source, writer_agent, trust_tier)
    VALUES ('reference', '__mig124_probe_downgrade', 'migration 124 verify probe',
            'migration 124 verify probe row', 'wren', 'wren', 'low')
    RETURNING id, trust_tier INTO v_down_id, v_down_tier;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE EXCEPTION 'migration 124: verify probe insert failed — %', v_msg;
  END;

  -- Clean up before asserting, so a failed assertion still leaves no residue.
  -- Deleting a memory fires memories_audit (memory_log) and memories_forget_audit
  -- (memory_forget_audit, review_status='pending' — which would queue an LLM
  -- review of a throwaway probe row). Both trails are swept after the delete.
  DELETE FROM memory_log          WHERE memory_id IN (v_up_id, v_down_id);
  DELETE FROM memories            WHERE id        IN (v_up_id, v_down_id);
  DELETE FROM memory_log          WHERE memory_id IN (v_up_id, v_down_id);
  DELETE FROM memory_forget_audit WHERE memory_id IN (v_up_id, v_down_id);

  IF v_up_tier IS DISTINCT FROM 'low' THEN
    RAISE EXCEPTION
      'migration 124: ELEVATION NOT CAPPED — dreaming_consolidate (derives low) asked for high and stored %', coalesce(v_up_tier, '<null>');
  END IF;

  IF v_down_tier IS DISTINCT FROM 'low' THEN
    RAISE EXCEPTION
      'migration 124: DOWNGRADE BROKEN — wren (derives high) asked for low and stored %', coalesce(v_down_tier, '<null>');
  END IF;

  RAISE NOTICE 'migration 124: verified both directions — elevate high->% (capped), downgrade high->% (honoured)', v_up_tier, v_down_tier;
END
$verify$;
