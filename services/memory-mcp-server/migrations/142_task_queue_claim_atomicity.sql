-- Migration 142: Add atomic task claim function and guarded claimed_at stamping
--
-- Problem: atlas-queue-check.sh documented "UPDATE task_queue SET status=in_progress_agent WHERE id=..."
-- which leaves claimed_at and claimed_by NULL, creating zombie rows the reaper cannot catch.
--
-- Solution:
-- 1. claim_task(task_id, agent_name) — atomically sets status, claimed_at, claimed_by
-- 2. BEFORE UPDATE trigger — auto-stamps claimed_at if transitioning to claimed/in_progress_agent with NULL claimed_at

BEGIN;

-- claim_task(task_id, agent_name) — atomic claim operation
CREATE OR REPLACE FUNCTION claim_task(p_task_id uuid, p_agent_name text)
RETURNS jsonb AS $$
DECLARE
  v_result jsonb;
BEGIN
  UPDATE task_queue
  SET
    status = 'in_progress_agent',
    claimed_by = p_agent_name,
    claimed_at = COALESCE(claimed_at, now()),  -- stamp only if NULL
    updated_at = now()
  WHERE id = p_task_id
    AND archived_at IS NULL
    AND status != 'in_progress_agent'  -- idempotent: no-op if already claimed
  RETURNING jsonb_build_object(
    'id', id,
    'status', status,
    'claimed_by', claimed_by,
    'claimed_at', claimed_at
  ) INTO v_result;

  RETURN COALESCE(v_result, jsonb_build_object('error', 'task not found or already in_progress_agent'));
END;
$$ LANGUAGE plpgsql;

-- BEFORE UPDATE trigger to guard against NULL claimed_at in in-flight statuses
CREATE OR REPLACE FUNCTION task_queue_guard_claimed_at()
RETURNS TRIGGER AS $$
BEGIN
  -- If transitioning INTO claimed/in_progress_agent and claimed_at is NULL, stamp it now
  IF NEW.status IN ('claimed', 'in_progress_agent')
    AND NEW.claimed_at IS NULL
    AND (OLD.status IS NULL OR OLD.status NOT IN ('claimed', 'in_progress_agent'))
  THEN
    NEW.claimed_at := COALESCE(NEW.claimed_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_queue_guard_claimed_at ON task_queue;
CREATE TRIGGER task_queue_guard_claimed_at
BEFORE UPDATE ON task_queue
FOR EACH ROW
EXECUTE FUNCTION task_queue_guard_claimed_at();

COMMIT;
