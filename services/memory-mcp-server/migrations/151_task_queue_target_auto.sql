-- 151: allow target='auto' on task_queue.
--
-- The dashboard's New Task form offers an "— unassigned —" target, but task_queue.target
-- is NOT NULL with a CHECK constraint, so the form's null/'' submission failed with 23502
-- and the UI showed a generic red "Failed to create task".
--
-- poll_queue.py has had route_auto_tasks() since day one: it picks up target='auto' rows,
-- classifies them via Nemotron (keyword fallback) and rewrites target to a real agent.
-- That code was unreachable because 'auto' was never a legal value. Adding it here makes
-- "unassigned" mean "let the router decide", which is what the dropdown implies.

ALTER TABLE public.task_queue DROP CONSTRAINT IF EXISTS task_queue_target_check;
ALTER TABLE public.task_queue ADD CONSTRAINT task_queue_target_check
  CHECK (target = ANY (ARRAY[
    'claude-code'::text, 'cowork'::text, 'chat'::text, 'desktop'::text, 'any'::text,
    'iris'::text, 'wren'::text, 'atlas'::text, 'jeff'::text, 'auto'::text
  ]));
