-- 135: the series guard mem0 needs, and the one dated series that was invisible
--      to every guard we have.
--
-- PART 1 — memory_names_are_series(uuid[])
--   The mem0 loop in src/index.ts now gates its CONFLICT decisions on "is this
--   candidate part of a recurring dated series?". There are TWO registries that
--   answer that and they do not overlap:
--     * public.research_producers   (migration 126) — exact '{date}' templates
--       for the daily-research producer set.
--     * memory_is_log_series()      (migration 087) — slug patterns mirroring
--       COLLAPSE_RULES in sync-memory.py.
--   Asking both from TypeScript would mean shipping the producer-template join
--   into the client. This RPC is the single answer, batched over the candidate
--   set so mem0 pays one round-trip per remember() call, not one per candidate.
--
--   The guard MUST stay client-side of supersede_memory(). It is deliberately
--   NOT installed in that RPC, because monthly_research_consolidation.py
--   legitimately supersedes point-in-time dailies into a digest through it
--   (migration 105) — an RPC-level guard would break monthly consolidation.
--
-- PART 2 — 'State of Lab — <date>' is a point-in-time series
--   The 2026-08-24 03:30Z sweep retired State of Lab 08-21, 08-22 and 08-23 in
--   favour of 08-24 via last_writer_wins. Migration 133's point-in-time guard
--   did NOT stop it and could not have: dreaming_consolidate.py writes that
--   series with is_point_in_time defaulted to FALSE, because
--   memory_is_log_series() never matched the slug. So the series was classified
--   as three standing claims about lab state that disagreed with each other,
--   which is exactly what last_writer_wins is for.
--
--   It is a nightly digest keyed on a date. Same category as the dreaming
--   summaries written by the same script, three lines away, which ARE matched.
--   Fix the classification and migration 133 covers it for free — no new
--   special case in the resolution path.
--
-- WHY NOT register it in research_producers instead
--   research_producers is the daily-RESEARCH producer set; research_coverage()
--   keys on it to decide whether a day's research happened. A nightly
--   state-of-lab digest is not research, and covers_days=false would only mute
--   the symptom while still putting a non-research series in the research
--   registry. memory_is_log_series() is the right home: it already owns
--   "recurring dated writer-generated log series", which this is.

BEGIN;

-- ── PART 1: batched series predicate for the mem0 guard ─────────────────────
CREATE OR REPLACE FUNCTION public.memory_names_are_series(p_ids uuid[])
RETURNS TABLE (id uuid, is_series boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT m.id,
         public.memory_is_log_series(m.name)
         OR EXISTS (
           SELECT 1 FROM public.research_producers p
           WHERE p.active
             AND m.name ~ '\d{4}-\d{2}-\d{2}'
             AND m.name = replace(p.name_template, '{date}',
                                  substring(m.name from '\d{4}-\d{2}-\d{2}')))
  FROM public.memories m
  WHERE m.id = ANY(p_ids);
$function$;

COMMENT ON FUNCTION public.memory_names_are_series(uuid[]) IS
  'Batched "does this name belong to a recurring dated series?" over BOTH '
  'registries: memory_is_log_series() slug patterns (087) and research_producers '
  'templates (126). Consumed by the mem0 CONFLICT gate in src/index.ts, which '
  'must never flag two entries of a dated series against each other — they '
  'differ by DAY, not by disagreement.';

REVOKE ALL ON FUNCTION public.memory_names_are_series(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.memory_names_are_series(uuid[]) TO service_role, authenticated;

-- ── PART 2a: teach memory_is_log_series about the state-of-lab digest ───────
-- Patches the LIVE definition by inserting one alternative, so unrelated drift
-- since 087 (the 'semantic:'/'weekly-ref:' prefix stripping added later) is
-- preserved rather than silently reverted. Raises if the anchor moved.
DO $mig135$
DECLARE
  v_def    text;
  v_anchor text := $a$        OR slug ~ '^dreaming(_summary)?_'$a$;
  v_add    text := $a$        OR slug ~ '^state_of_lab_20\d'
        OR slug ~ '^dreaming(_summary)?_'$a$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'memory_is_log_series' AND n.nspname = 'public';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 135: memory_is_log_series not found';
  END IF;
  IF position('state_of_lab' in v_def) > 0 THEN
    RAISE NOTICE 'migration 135: state_of_lab pattern already present, skipping';
  ELSE
    IF position(v_anchor in v_def) = 0 THEN
      RAISE EXCEPTION 'migration 135: dreaming anchor not found -- memory_is_log_series drifted, patch by hand';
    END IF;
    EXECUTE replace(v_def, v_anchor, v_add);
    RAISE NOTICE 'migration 135: state_of_lab pattern added to memory_is_log_series';
  END IF;
END
$mig135$;

-- Receipt: the pattern must actually match the live names.
DO $check135$
BEGIN
  IF NOT public.memory_is_log_series('State of Lab — 2026-08-24') THEN
    RAISE EXCEPTION 'migration 135: state_of_lab pattern does not match the live name format';
  END IF;
  IF public.memory_is_log_series('lab-degradation-incident-2026-07-02') THEN
    RAISE EXCEPTION 'migration 135: state_of_lab pattern over-matches one-off dated incident notes';
  END IF;
END
$check135$;

-- ── PART 2b: backfill the flag on the existing series ───────────────────────
UPDATE public.memories
   SET is_point_in_time = true
 WHERE NOT is_point_in_time
   AND public.memory_is_log_series(name);

-- ── PART 2c: restore what the 03:30 sweep retired on 2026-08-24 ─────────────
-- Same repair shape as the 2026-08-24 21:00Z mem0 restoration: clear the
-- retirement, clear the bi-temporal close, drop the invented 'supersedes' edge,
-- and LOG the unsupersede (migrations 131/132 made that insert possible).
WITH bad AS (
  SELECT l.source_id AS old_id, l.target_id AS new_id
  FROM public.memory_links l
  JOIN public.memories s ON s.id = l.source_id
  WHERE l.relationship = 'supersedes'
    AND l.metadata->>'resolution_heuristic' = 'last_writer_wins'
    AND l.metadata->>'reason' LIKE 'deterministic conflict resolution (migration 063)%'
    AND s.name LIKE 'State of Lab%'
), restored AS (
  UPDATE public.memories m
     SET is_active = true, superseded_by = NULL, valid_to = NULL
    FROM bad WHERE m.id = bad.old_id
  RETURNING m.id, m.name
), logged AS (
  INSERT INTO public.memory_log (memory_id, action, source, details)
  SELECT r.id, 'unsupersede', 'system',
         jsonb_build_object(
           'actor', 'migration-135',
           'name', r.name,
           'reason', 'restored — State of Lab is a dated point-in-time series, not three '
                     'standing claims that disagree. Retired 2026-08-24 03:30Z by '
                     'resolve_conflict_auto last_writer_wins because is_point_in_time was false.')
  FROM restored r
  RETURNING 1
)
DELETE FROM public.memory_links l
USING bad
WHERE l.source_id = bad.old_id AND l.target_id = bad.new_id
  AND l.relationship = 'supersedes';

COMMIT;
