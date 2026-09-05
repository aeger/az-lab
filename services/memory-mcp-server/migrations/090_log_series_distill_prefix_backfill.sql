-- Migration 090: teach memory_is_log_series() about distill name prefixes, and
-- backfill the rows that blind spot left unflagged.
--
-- WHY
--   episodic_distill.py re-emits consolidated copies under a stable prefixed name --
--   cluster_ref_name() builds "weekly-ref:<label>", and the semantic distiller writes
--   "semantic:<parent name>". The "weekly-ref:" family happens to match the existing
--   ^weeklyref_ pattern once slugged, so those were flagged. The "semantic:" family
--   was not: "semantic:Daily AI Memory Research - 2026-05-24 Triage" slugs to
--   semantic_daily_ai_memory_research_... which no pattern anchors on. Seven distilled
--   copies of already-immutable log series were therefore sitting outside the flag,
--   taking a staleness discount their own parents are exempt from.
--
-- METHOD -- additive, never subtractive
--   The series test now runs against BOTH the raw name and the prefix-stripped name,
--   OR'd together. Deliberately not "strip, then test": stripping "weekly-ref:" would
--   leave "memory-mcp-server", which matches nothing, so a rewrite would REMOVE
--   auto-flagging from the weekly-ref writer. OR'ing means nothing that matches today
--   can stop matching, and the change can only ever flag more rows, never fewer.
--
--   Still no dated-name regex, and still no blanket UPDATE over dated names. The
--   backfill below runs strictly through the function, so it can only touch names that
--   are provably part of a recurring writer-generated series. Every remaining dated row
--   stays reviewable -- several of them (supabase-key-rotation-2026-04-30,
--   ha_vm_ram_bump_20260514, cadvisor-cpu-cap-20260627) assert live config despite
--   their dated names.
--
-- KNOWN PARALLEL GAP (not fixed here, DB-side only)
--   COLLAPSE_RULES in /home/almty1/claude/scripts/sync-memory.py has the same blind
--   spot, so these seven show as individual lines in MEMORY.md instead of collapsing
--   into their series glob. That is cosmetic index noise, not a staleness bug.

-- 1. predicate ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.memory_is_log_series(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_name IS NULL THEN false ELSE (
    WITH raw AS (
      -- Test the name as written AND with a distillation prefix removed, so a
      -- distilled copy inherits its parent series' immutability.
      SELECT p_name AS n
      UNION ALL
      SELECT regexp_replace(p_name, '^(semantic|episodic|ref|weekly-ref|summary):\s*', '', 'i')
    ),
    s AS (
      SELECT trim(both '_' from
               regexp_replace(
                 regexp_replace(lower(n), '[''—–\-]', '', 'g'),
                 '[^a-z0-9]+', '_', 'g')) AS slug
      FROM raw
    )
    SELECT bool_or(
           slug ~ '^ai_memory_research_\d'
        OR slug ~ '^daily_selfimprovement_research_\d'
        OR slug ~ '^ai_research_20\d'
        OR slug ~ '^(research|daily).*(triage|review|closeout|synthesis)'
        OR slug ~ '^dailyaimemoryresearchtriage'
        OR slug ~ '^dreaming(_summary)?_'
        OR slug ~ '^weeklyref_'
        OR slug ~ 'tech_breakthrough'
        OR slug ~ '^constitutionaudit'
        OR slug ~ '^weeklyrlsaudit'
    )
    FROM s
  ) END;
$function$;

COMMENT ON FUNCTION public.memory_is_log_series(text) IS
  'True for recurring dated log-series names (daily research, triage/closeout, dreaming, '
  'tech-breakthrough, weekly audits), tested against the raw name and against the name '
  'with a distillation prefix (semantic:/ref:/weekly-ref:/...) stripped. Mirrors '
  'COLLAPSE_RULES in sync-memory.py. Deliberately conservative -- one-off dated incident '
  'records are NOT matched, because they often carry standing config claims that must '
  'stay reviewable.';

-- 2. backfill, strictly through the function ----------------------------------
UPDATE public.memories
   SET is_point_in_time = true
 WHERE is_point_in_time = false
   AND memory_is_log_series(name);

-- 3. reconcile the staleness cache --------------------------------------------
-- staleness_candidate is only a cache for recall's confidence haircut (085). It still
-- reads true on every immutable log until a sweep runs, so recall would keep applying
-- STALE_CONFIDENCE_FACTOR to them for up to 24h after 089 landed. Reconcile now.
SELECT public.flag_stale_memories();
