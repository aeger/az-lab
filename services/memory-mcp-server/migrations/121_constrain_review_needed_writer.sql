-- Migration 121: constrain the WRITER of task_queue.status='review_needed'
-- ─────────────────────────────────────────────────────────────────────────
-- MEASURED DEFECT (2026-08-17). Migration 118 (08-15) retired `review_needed`
-- in the READERS only — it gave task_queue_health a CASE arm and added the status
-- to task_queue_attention, and it removed the status from IRIS_EVAL_GUIDANCE in
-- poll_queue.py. The status stayed in the vocabulary, so the producer kept producing:
--
--   abb0f54f  "Research impl 2026-08-16 [1/3]" set to review_needed 2026-08-16
--             16:29:25Z — two minutes after commit f2d801d closed its own
--             engineering — still open 24h later.
--   846ff20e  "Discord: Weekly constitution audit" — created 2026-05-03, open 105 days.
--
-- Every alerting layer worked. task_queue_health returned reason='attention'; pg_cron
-- job task-queue-health (7 * * * *) succeeded hourly; net._http_response shows HTTP 204
-- at 08-16 17:07 and 18:07; task_queue_alert_state.alert_count=9. The silence after
-- 18:07 is the intended 24h digest suppression, not a delivery failure.
--
-- Detection worked, delivery worked, and the rows rotted anyway. An alert is not a
-- resolution path. `review_needed` is unclaimable — poll_queue.py claims in
-- (ready, pending, delegated) — so no reader on any code path can move it, and the
-- hourly digest just re-reported the same two rows into a channel nobody actions.
--
-- THE PRODUCER, named at last: ~/claude-queue/sage.py, the always-on Sage evaluator
-- (systemd user unit sage.service). It PATCHes status='review_needed' in two branches:
--   1. verify-gate       — deployable change with no verification proof in the result
--   2. suggestions-found — result contains a plan/recommendation Jeff must decide on
-- Both live rows carry Sage's fingerprint in context.context_summary ("Verify-gate:
-- confirm `X` change is actually live"). 118's own header guessed at "Iris, Sage, a CCR
-- trigger" as possible writers and settled for making them visible; it never went and
-- looked. Sage was also untracked — the file existed only under ~/claude-queue, so a
-- repo-wide grep for the producer found nothing. Same commit adds it to the repo.
--
-- This is the third occurrence: migration 035 documents the first (Sage flipped
-- recurring tasks to review_needed with target=jeff and the poller's target filter
-- never claimed them), 118 the second. 035 fixed routing for recurring rows, 118 fixed
-- readers. Both left the write intact, and the status rotted a different lane each time.
--
-- FIX: coerce at the write, not alert after the fact.
--   1. BEFORE INSERT OR UPDATE trigger rewrites review_needed -> pending_jeff_action.
--   2. task_queue_status_check drops 'review_needed' from the vocabulary, so if the
--      trigger is ever dropped or disabled the write fails loudly instead of silently
--      reintroducing the rot lane.
--
-- WHY pending_jeff_action, NOT completed. The brief offered "reject, or map to
-- completed". Mapping to completed would silently mark done a row an evaluator
-- deliberately flagged for human eyes — the same invisibility failure 118 explicitly
-- considered and rejected under "NOT auto-archive-on-a-timer... do not make it
-- self-erasing". pending_jeff_action carries the identical semantic (a human must look)
-- and, unlike review_needed, has readers: task_queue_health has an 'awaiting_jeff' arm,
-- task_queue_attention lists it, the dashboard ranks it in JEFF_URGENT, and
-- poll_queue.mark_pending_jeff_action already Discord-notifies on it. Sage's own
-- "result looks incomplete" branch has always used that lane. The two review_needed
-- branches were the outliers.
--
-- Hard reject was the other candidate and was rejected for one measured reason: the
-- dashboard offers review_needed as a transition destination from nine states
-- (dashboard app/api/taskqueue/[id]/status/route.ts), so a CHECK-only fix turns a
-- button Jeff presses into a 400. Coercion keeps every existing writer working and
-- lands them in a lane that gets read. The stamped context.coerced_from makes the
-- coercion auditable rather than silent.
--
-- Apply via scripts/apply_sql.sh (Management API).

BEGIN;

-- ─────────────────────────────────────────── 1. close the two live rows
-- abb0f54f: engineering verified live first-hand, not on self-report —
-- ~/claude-queue/poll_queue.py is a symlink resolving to
-- ~/azlab/infrastructure/task-queue/poll_queue.py, md5 1225dc0f... on both paths,
-- and systemctl --user cat claude-queue-poll.service confirms ExecStart targets it.
-- 846ff20e: the deliverable was a Discord post to #claude-code; result records
-- "Message delivered to #claude-code" and the weekly audit series continued past it.
UPDATE public.task_queue
   SET status = 'completed',
       result = coalesce(result, '')
                || E'\n\n---\n**Closed by migration 121 (2026-08-17):** this row sat in the '
                || 'retired `review_needed` status, which no reader can claim or sweep. '
                || 'Engineering was already shipped and verified; the row was open only '
                || 'administratively. The Sage write path that produced it now coerces to '
                || '`pending_jeff_action`.',
       context = coalesce(context, '{}'::jsonb)
                 || jsonb_build_object('closed_by', 'migration_121',
                                       'closed_from_status', 'review_needed')
 WHERE id IN ('abb0f54f-c0b3-4b85-9f27-0ea4a3ec0065',
              '846ff20e-c4a9-46ca-a2f6-14ba8a736555')
   AND status = 'review_needed';

-- ─────────────────────────────────────────── 2. coerce the write
CREATE OR REPLACE FUNCTION public.task_queue_coerce_retired_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'review_needed' THEN
    NEW.status  := 'pending_jeff_action';
    NEW.target  := coalesce(NEW.target, 'jeff');
    NEW.context := coalesce(NEW.context, '{}'::jsonb)
                   || jsonb_build_object('coerced_from', 'review_needed',
                                         'coerced_by',   'migration_121',
                                         'coerced_at',   to_char(now() at time zone 'utc',
                                                                 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    -- system_rules.review_tasks_require_action_required: the dashboard headlines
    -- context.action_required on every review card. Never leave it null.
    IF coalesce(NEW.context->>'action_required', '') = '' THEN
      NEW.context := NEW.context
                     || jsonb_build_object('action_required',
                          'Review this result and either approve (status=completed) or send it back (status=ready).');
    END IF;
    RAISE WARNING 'task_queue %: status review_needed is retired (migration 118/121) -- coerced to pending_jeff_action. Fix the writer: use ready to send work back, pending_jeff_action for a human gate, completed to approve.',
                  coalesce(NEW.id::text, '(new)');
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.task_queue_coerce_retired_status() IS
  'Write-side retirement of task_queue.status=review_needed (migration 121, 2026-08-17). '
  'Rewrites it to pending_jeff_action -- same semantic, but a lane with readers '
  '(task_queue_attention, task_queue_health awaiting_jeff, dashboard JEFF_URGENT). '
  'Stamps context.coerced_from so the rewrite is auditable. Third occurrence of the '
  'same rot: see migrations 035 and 118, both of which fixed readers only.';

-- Named to sort first among task_queue BEFORE triggers so the status is already
-- normalised before trg_task_queue_archive_on_terminal inspects it.
DROP TRIGGER IF EXISTS trg_aa_task_queue_coerce_retired_status ON public.task_queue;
CREATE TRIGGER trg_aa_task_queue_coerce_retired_status
  BEFORE INSERT OR UPDATE ON public.task_queue
  FOR EACH ROW EXECUTE FUNCTION public.task_queue_coerce_retired_status();

-- ─────────────────────────────────────────── 3. drop it from the vocabulary
-- Belt and braces: if the trigger is ever dropped, DISABLEd, or bypassed by a
-- session that set session_replication_role, the write must fail rather than
-- silently recreate an unclaimable lane.
ALTER TABLE public.task_queue DROP CONSTRAINT IF EXISTS task_queue_status_check;
ALTER TABLE public.task_queue ADD CONSTRAINT task_queue_status_check
  CHECK (status = ANY (ARRAY[
    'backlog', 'ready', 'in_progress_agent', 'in_progress_jeff',
    'pending_jeff_action', 'blocked', 'paused', 'completed', 'cancelled',
    'archived', 'hand_back', 'pending', 'claimed', 'failed', 'escalated',
    'expired', 'delegated', 'pending_eval'
    -- 'review_needed' REMOVED 2026-08-17 (migration 121). Retired by 118.
  ]));

COMMIT;

-- ─────────────────────────────────────────── verification (run separately)
--   INSERT INTO task_queue (title, description, status, source, target, priority)
--   VALUES ('m121 writer test', 'test', 'review_needed', 'claude-code', 'jeff', 3)
--   RETURNING id, status, context;
-- Expected: status='pending_jeff_action', context.coerced_from='review_needed',
-- plus a WARNING on the connection. 118's readers keep their review_needed CASE arms
-- as dead-code backstops; they are now unreachable, which is the point.
