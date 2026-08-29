-- Migration 144: task_queue.execution_count — count executions without touching retry budget
--
-- Finding (2026-08-28): neither existing counter tracks executions.
--   attempt_count increments ONLY in poll_queue.mark_failed(). That is correct and intended:
--     it is a RETRY BUDGET, compared against max_attempts to choose retry-vs-escalate. Making it
--     increment on success would consume that budget on healthy re-runs (a task would escalate to
--     'failed' after 3 good runs), would make build_prompt inject a false "RETRY ATTEMPT n — this
--     task previously failed" hint, and would break the never_run scoping
--     (`not attempt_count and not claimed_at`) in poll_queue.py. Not changed here.
--   run_count is written only by record_scheduled_run()/upsert_recurring_task(), i.e. it counts
--     firings of a RECURRING schedule. For a one-shot delegated task it is structurally always 0
--     (4 of 2246 rows are non-zero). Also not changed here.
--
-- So a row on its third execution reads attempt_count=0, run_count=0 — indistinguishable from
-- never-run. That is how c958ef26 and 325e83d6 silently re-ran over completed results.
--
-- Fix: a separate, additive execution_count incremented on the ready -> in-flight transition,
-- inside the migration-142 guard trigger. The trigger is the right seam because the poller claims
-- with a bare PATCH (poll_queue.py:744), not via claim_task(), so a trigger is the only point that
-- catches EVERY claim path — including the undocumented bare-SQL write that creates zombies.
-- The existing guard only fires when OLD.status is not already in-flight, so claimed ->
-- in_progress_agent does not double-count: exactly one increment per claim cycle.
--
-- No retry semantics change. Nothing reads execution_count yet except task_queue_zombies (143).

BEGIN;

ALTER TABLE public.task_queue
  ADD COLUMN IF NOT EXISTS execution_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.task_queue.execution_count IS
  'Number of times this row has been claimed for execution, incremented by '
  'task_queue_guard_claimed_at() on the transition into claimed/in_progress_agent. '
  'Distinct from attempt_count (retry budget vs max_attempts, failure path only) and '
  'run_count (recurring-schedule firings). execution_count > 1 on a non-recurring task '
  'means it was re-run; see task_queue_zombies.zombie_class = result_over_run.';

-- Extend the 142 guard rather than adding a second trigger, so claim stamping and execution
-- counting stay in one place and cannot disagree about what "a claim" is.
CREATE OR REPLACE FUNCTION public.task_queue_guard_claimed_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('claimed', 'in_progress_agent')
    AND (OLD.status IS NULL OR OLD.status NOT IN ('claimed', 'in_progress_agent'))
  THEN
    -- 142: stamp claimed_at so the row is reapable by age.
    NEW.claimed_at := COALESCE(NEW.claimed_at, now());
    -- 144: count the execution. Guarded by the same transition test, so a
    -- claimed -> in_progress_agent promotion does not double-count.
    NEW.execution_count := COALESCE(OLD.execution_count, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
