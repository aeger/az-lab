-- Migration 069: one-call memory health snapshot for the weekly Discord report.
--
-- WHY A DEDICATED FUNCTION AND NOT A GENERIC exec_sql RPC: the report needs ~15
-- aggregates across 6 tables. The tempting shortcut is a generic "run this SQL"
-- RPC, but that is a permanent arbitrary-SQL execution surface on the memory
-- store purely to save writing one function. This is the narrow version.
--
-- Feeds memory_health_report.py (2026-07-23 research rec 3): the 425-row / 4-month
-- stale backlog went unnoticed precisely because nothing reported these numbers.

CREATE OR REPLACE FUNCTION public.memory_health_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total',           (SELECT count(*) FROM memories),
    'active',          (SELECT count(*) FROM memories WHERE COALESCE(is_active,true) IS NOT FALSE),
    'retired',         (SELECT count(*) FROM memories WHERE is_active IS FALSE),
    'hot',             (SELECT count(*) FROM memories WHERE memory_tier='hot'  AND COALESCE(is_active,true) IS NOT FALSE),
    'warm',            (SELECT count(*) FROM memories WHERE memory_tier='warm' AND COALESCE(is_active,true) IS NOT FALSE),
    'cold',            (SELECT count(*) FROM memories WHERE memory_tier='cold' AND COALESCE(is_active,true) IS NOT FALSE),
    'pinned',          (SELECT count(*) FROM memories WHERE lifecycle_pinned),
    'never_accessed',  (SELECT count(*) FROM memories WHERE COALESCE(access_count,0)=0 AND COALESCE(is_active,true) IS NOT FALSE),
    'queue_depth',     (SELECT count(*) FROM stale_memories_review_queue),
    'queue_head_age',  (SELECT EXTRACT(DAY FROM now()-min(created_at))::int FROM stale_memories_review_queue),
    'retire_eligible', (SELECT count(*) FROM memory_retirement_candidates WHERE NOT in_duplicate_cluster),
    'retire_held_dup', (SELECT count(*) FROM memory_retirement_candidates WHERE in_duplicate_cluster),
    'dup_rows',        (SELECT count(*) FROM (
                          SELECT id_a AS id FROM memory_duplicate_pairs
                          UNION SELECT id_b FROM memory_duplicate_pairs) d),
    'conflicts_open',  (SELECT count(*) FROM memory_conflicts WHERE COALESCE(resolved,false)=false),
    'autoretire',      (SELECT value FROM memory_lifecycle_settings WHERE key='autoretire_enabled'),
    'writers',         (SELECT COALESCE(jsonb_agg(w), '[]'::jsonb) FROM (
                          SELECT COALESCE(writer_agent,'(unknown)') AS agent, count(*) AS n
                          FROM memories WHERE created_at > now()-interval '7 days'
                          GROUP BY 1 ORDER BY 2 DESC) w),
    'eval',            (SELECT to_jsonb(e) FROM (
                          SELECT tag, recall_at_5, mrr, created_at AS "when"
                          FROM eval_runs ORDER BY created_at DESC LIMIT 1) e)
  )
$$;

COMMENT ON FUNCTION public.memory_health_snapshot IS
  'Single-call health aggregate for the weekly memory report (migration 069). Deliberately narrow rather than a generic exec_sql RPC.';

GRANT EXECUTE ON FUNCTION public.memory_health_snapshot() TO service_role, authenticated;
