-- 112_skill_usage_single_writer.sql
--
-- WHY (2026-07-29 research REC 3, verified 2026-08-11): skill telemetry has two
-- unreconciled write paths and the counters visibly disagree.
--
--   discord-azlab-mcp             use_count=1  success_count=32
--   git-workflow-azlab            use_count=2  success_count=3
--   daily-email-triage            use_count=2  last_used_at=NULL
--   provision-proxmox-vm-cloud-init use_count=2 last_used_at=NULL
--
-- `record_skill_outcome` (080) is already atomic and already stamps last_used_at.
-- The broken half is `recall_skill` in src/index.ts, which does a read-modify-write
-- in THREE separate code paths:
--
--     .update({ use_count: (s.use_count || 0) + 1, ... }).eq("id", s.id)
--
-- That is a lost-update race, not a style problem: the value written is the one
-- read by THAT request, so two concurrent recalls of the same skill (the normal
-- case — Wren, Iris and the poller all hold the same MCP server) both write N+1
-- and one bump vanishes. In the semantic/keyword branches it is also a sequential
-- await per row, so a 3-result recall is 3 round trips that can interleave with
-- each other. use_count is therefore a LOWER BOUND on real usage, which is exactly
-- how it ends up below success_count.
--
-- This migration makes the increment atomic and server-side, so recall_skill has
-- one statement to call and `use_count` and `last_used_at` can never diverge —
-- they are written by the same UPDATE or neither is.
--
-- Deliberately NOT done here: collapsing record_skill_outcome into this function.
-- The two record different things (selection vs outcome) and REC 3a asks for one
-- writer of USAGE, not one writer of everything. Both now stamp last_used_at
-- through an atomic UPDATE, which is what "unreconciled" actually meant.

-- ── 1. The single usage writer ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_skill_usage(p_skill_ids uuid[])
RETURNS TABLE(id uuid, name text, use_count integer, last_used_at timestamptz)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.skills s
     SET use_count    = COALESCE(s.use_count, 0) + 1,
         last_used_at = now()
   WHERE s.id = ANY(p_skill_ids)
  RETURNING s.id, s.name, s.use_count, s.last_used_at;
$function$;

COMMENT ON FUNCTION public.bump_skill_usage(uuid[]) IS
  'THE single writer for skills.use_count / last_used_at on selection. Atomic read-modify-write in one statement, so concurrent recalls cannot lose a bump, and use_count can never advance without last_used_at. Called only by recall_skill (src/index.ts). Outcome counters belong to record_skill_outcome (080). Migration 112, 2026-08-11 (research REC 3a).';

GRANT EXECUTE ON FUNCTION public.bump_skill_usage(uuid[]) TO anon, authenticated, service_role;

-- ── 2. Guard: use_count must never advance without last_used_at ───────────────
-- The two stragglers below are pre-058 rows (last_used_at was only added on
-- 2026-07-16, so their bumps genuinely predate the column and there is no ground
-- truth to recover — agent_episodes has 0 rows for either, memory_log carries no
-- skill reference at all). Migration 104 already replayed everything that WAS
-- recoverable. Rather than invent a timestamp, this records the floor we can
-- honestly defend: they were used at or before the day the column shipped.
UPDATE public.skills
   SET last_used_at = TIMESTAMPTZ '2026-07-16 00:00:00+00'
 WHERE last_used_at IS NULL
   AND COALESCE(use_count, 0) > 0;

-- ── 3. Skills-coverage in the nightly/weekly health snapshot ──────────────────
-- REC 3c. Only the LIVE (non-backfilled) outcome counts are reported as the
-- success rate, for the same reason migration 104 subtracts them in
-- skill_outcome_gaps: a backfill must not be able to turn the metric green while
-- the self-report loop stays dead.
CREATE OR REPLACE FUNCTION public.memory_health_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
                          FROM eval_runs ORDER BY created_at DESC LIMIT 1) e),
    -- REC 3c: skills coverage. `used` counts any evidence of selection (recall
    -- bump, replayed episode, or an attributed task), not just use_count, because
    -- use_count alone reads 4/33 while 9 skills demonstrably ran.
    'skills',          (SELECT to_jsonb(sk) FROM (
                          SELECT
                            count(*)                                              AS total,
                            count(*) FILTER (WHERE evidence_count > 0)            AS used,
                            count(*) FILTER (WHERE live_outcomes > 0)             AS reporting,
                            COALESCE(sum(GREATEST(live_outcomes, 0)), 0)          AS live_outcomes,
                            (SELECT COALESCE(sum(GREATEST(s2.success_count - s2.backfilled_success_count, 0)), 0)
                               FROM skills s2)                                    AS live_success,
                            (SELECT COALESCE(sum(GREATEST(s2.fail_count - s2.backfilled_fail_count, 0)), 0)
                               FROM skills s2)                                    AS live_fail,
                            count(*) FILTER (WHERE evidence_count > 0 AND live_outcomes = 0)
                                                                                  AS silent
                          FROM skill_outcome_gaps) sk)
  )
$function$;

COMMENT ON FUNCTION public.memory_health_snapshot() IS
  'One-call corpus/lifecycle/eval health snapshot for memory_health_report.py. Migration 069; skills-coverage block added by 112 (research REC 3c) — `used` pools every evidence-of-use source, `reporting`/`live_*` deliberately exclude migration-104 backfilled counts so a backfill cannot green the metric.';
