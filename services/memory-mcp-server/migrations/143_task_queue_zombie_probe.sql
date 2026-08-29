-- Migration 143: task_queue_zombies — standing probe for the unreapable in-flight class
--
-- Problem: task_queue_health's stuck_claim arm tests (now() - claimed_at) > stuck_claim_hours.
-- When claimed_at IS NULL that comparison is NULL, the CASE falls through to ELSE NULL, and the
-- row reads as healthy forever (the 2026-08-28 [1/2] finding; 142 fixed the write path so new
-- rows get claimed_at, but nothing detects a row that is in-flight yet not actually executing).
--
-- Two liveness classes, both of which read zero rows on a healthy queue:
--   silent_no_activity — in-flight, not archived, newest evidence of life older than 30 min.
--     "Evidence of life" is COALESCE(last agent_activity, claimed_at, updated_at), so a row with
--     zero agent_activity for its entire lifetime is caught, and a just-claimed row is not
--     (that grace gate is what keeps the probe quiet on a healthy queue).
--   result_over_run  — in-flight, not archived, with a non-empty result: a task being re-run
--     over the top of a completed result, which is how a row silently lands on its Nth execution.
--
-- Read-only view. No retry semantics are touched here.
--
-- NOTE ON execution_count: this migration deliberately does NOT reference
-- task_queue.execution_count. That column does not exist yet at 143 — migration 144 adds it and
-- then CREATE OR REPLACE's this view to append the column and widen the `decision` receipt. The
-- two files must stay in that order: 143 is the pre-144 form, 144 carries the final form. Editing
-- execution_count into this file makes the migration sequence unreplayable on a fresh database.

BEGIN;

CREATE OR REPLACE VIEW public.task_queue_zombies AS
WITH inflight AS (
  SELECT
    t.id,
    t.title,
    t.status,
    t.target,
    t.claimed_by,
    t.claimed_at,
    t.updated_at,
    t.attempt_count,
    t.run_count,
    length(COALESCE(btrim(t.result), '')) AS result_len,
    (SELECT max(a.created_at) FROM agent_activity a WHERE a.task_id = t.id) AS last_activity
  FROM task_queue t
  WHERE t.status = ANY (ARRAY['claimed'::text, 'in_progress_agent'::text])
    AND t.archived_at IS NULL
)
SELECT
  i.id,
  i.title,
  i.status,
  i.target,
  i.claimed_by,
  i.claimed_at,
  i.last_activity,
  i.result_len,
  i.attempt_count,
  i.run_count,
  CASE
    WHEN COALESCE(i.last_activity, i.claimed_at, i.updated_at) < (now() - interval '30 minutes')
      THEN 'silent_no_activity'::text
    ELSE 'result_over_run'::text
  END AS zombie_class,
  (i.last_activity IS NULL) AS never_executed,
  round(EXTRACT(epoch FROM (now() - COALESCE(i.last_activity, i.claimed_at, i.updated_at))) / 60.0, 1)
    AS silent_minutes,
  -- Receipt string: states what was tested, so a zero-row result is falsifiable rather than
  -- merely empty (same stance as task_queue_health's `decision` column).
  format(
    '%s — last_activity=%s, claimed_at=%s, silent %smin vs 30min gate; result_len=%s',
    CASE
      WHEN COALESCE(i.last_activity, i.claimed_at, i.updated_at) < (now() - interval '30 minutes')
        THEN 'FINDING silent_no_activity'
      ELSE 'FINDING result_over_run'
    END,
    COALESCE(i.last_activity::text, '(never)'),
    COALESCE(i.claimed_at::text, '(NULL - pre-142 bare-SQL write)'),
    round(EXTRACT(epoch FROM (now() - COALESCE(i.last_activity, i.claimed_at, i.updated_at))) / 60.0, 1),
    i.result_len
  ) AS decision
FROM inflight i
WHERE COALESCE(i.last_activity, i.claimed_at, i.updated_at) < (now() - interval '30 minutes')
   OR i.result_len > 0;

COMMENT ON VIEW public.task_queue_zombies IS
  'Standing probe for unreapable in-flight task_queue rows. Reads zero on a healthy queue. '
  'zombie_class=silent_no_activity: in-flight with no agent_activity newer than 30min (incl. '
  'never any, the class task_queue_health misses when claimed_at IS NULL). '
  'zombie_class=result_over_run: in-flight with a non-empty result, i.e. re-run over a completed '
  'result. Consumed by anomaly-heartbeat check_zombie_tasks(). See migrations 142, 143.';

GRANT SELECT ON public.task_queue_zombies TO service_role;

COMMIT;
