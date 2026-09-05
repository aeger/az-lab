-- 080_record_skill_outcome_rpc.sql
-- T2 (research 2026-07-25): close the skill outcome loop.
--
-- WHY
--   record_task_completion (src/index.ts:2266-2273) already writes success_count /
--   fail_count / last_outcome correctly. The code was never the problem — as of
--   2026-07-28, 27 skills existed and exactly ONE had a non-zero outcome counter,
--   because the tool depends on an agent remembering to call it. Skill quality data
--   that only accrues when someone remembers to log it does not accrue.
--
--   This RPC lets the task_queue poller record outcomes automatically, without an
--   MCP session handshake, from plain PostgREST. The poller is the right place: it
--   already observes every task's terminal state.
--
-- WHY AN RPC AND NOT A POSTGREST PATCH
--   The counter update is read-modify-write. PostgREST cannot express
--   `success_count = success_count + 1` — the client must SELECT then UPDATE, which
--   drops increments when the poller and an agent's record_task_completion land
--   concurrently. A single UPDATE ... SET c = c + 1 inside the DB is atomic.
--   (record_task_completion has this same read-modify-write race in TypeScript; it
--   is unchanged here by design — T2 says do not touch server code — and it is a
--   non-issue at az-lab's write rate, single-digit writes/day.)
--
-- SEMANTICS
--   - Unknown skill_name is a no-op returning false, NOT an error. The poller's
--     trigger matcher is heuristic and may name a skill that has since been renamed
--     or deleted; a bad match must never fail a task's completion path.
--   - last_used_at is stamped on every outcome so the "is this skill alive?" signal
--     tracks actual task usage, not just recall_skill reads.
--   - COALESCE guards the pre-migration-058 rows where the counters are NULL.

CREATE OR REPLACE FUNCTION public.record_skill_outcome(
  p_skill_name text,
  p_success    boolean,
  p_note       text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_found boolean;
BEGIN
  IF p_skill_name IS NULL OR btrim(p_skill_name) = '' OR p_success IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.skills
     SET success_count = COALESCE(success_count, 0) + (CASE WHEN p_success THEN 1 ELSE 0 END),
         fail_count    = COALESCE(fail_count, 0)    + (CASE WHEN p_success THEN 0 ELSE 1 END),
         last_outcome  = left(
                           COALESCE(
                             NULLIF(btrim(p_note), ''),
                             CASE WHEN p_success THEN 'success' ELSE 'failure' END
                           ), 500),
         last_used_at  = now(),
         updated_at    = now()
   WHERE name = p_skill_name;

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found;
END;
$$;

COMMENT ON FUNCTION public.record_skill_outcome(text, boolean, text) IS
  'Atomically increment success_count/fail_count and stamp last_outcome/last_used_at for a skill. Returns false if no such skill (no-op, not an error). Called by the task_queue poller on terminal task states — see infrastructure/task-queue/poll_queue.py.';

GRANT EXECUTE ON FUNCTION public.record_skill_outcome(text, boolean, text) TO service_role;
