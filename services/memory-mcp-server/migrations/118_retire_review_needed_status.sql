-- Migration 118: retire `review_needed`, and make any straggler visible
-- ─────────────────────────────────────────────────────────────────────
-- MEASURED DEFECT. On 2026-08-15 two task_queue rows sat at status='review_needed'
-- with their engineering fully shipped and verified:
--   3b977d57  FCFR denominator gate      -> commit fbcfdcd (08-13), open 2 days
--   729edee2  A-MAC fifth term input     -> commits a52d8f2 + 935de4a, migrations
--                                           116/116a/117 applied (08-14), open 1 day
-- Both read as OPEN to the next research run's completion query, understating the
-- v17 delegation rate as 2/3 when the true rate was 3/3 landed as engineering and
-- 1/3 never closed administratively.
--
-- ROOT CAUSE: `review_needed` is a write-only status. Nothing claims it — poll_queue
-- claims in.(ready,pending,delegated). Nothing sweeps it — the duplicate-work guard
-- lists ready/pending/claimed/failed/pending_eval/in_progress_agent/pending_jeff_action.
-- task_queue_attention omits it. And task_queue_health (migration 110) *scans* it —
-- its WHERE only excludes completed/cancelled/archived — but no CASE arm matches, so
-- reason came back NULL, i.e. "healthy". That is why an hourly cron digest looked
-- straight past two stalled rows for two days. A status that means "done but still
-- open" and that no reader can act on will keep producing this.
--
-- This is the second occurrence. Migration 035 documents the first: Sage flipped
-- recurring tasks to review_needed with target=jeff, the poller's target filter never
-- claimed them, and the cycle repeated. 035 fixed the routing for recurring rows only;
-- the status itself was left in the vocabulary and rotted a different lane.
--
-- FIX, two halves:
--   1. Producer (poll_queue.py, same commit): IRIS_EVAL_GUIDANCE no longer offers
--      review_needed. "Needs changes" and "Send back" both collapse to `ready`, which
--      the poller actually re-claims and which already carries notes into build_prompt.
--      The two actions were redundant to begin with.
--   2. Backstop (here): anything that still writes review_needed — Iris, Sage, a CCR
--      trigger, a human at the SQL prompt — now surfaces as 'attention' on the hourly
--      digest and in task_queue_attention instead of silently reading as healthy.
--
-- NOT auto-archive-on-a-timer. That was the alternative considered and rejected: it
-- would bury a row an evaluator had deliberately flagged, which is the same
-- invisibility failure with a tidier queue. Make the status impossible to produce and
-- impossible to hide; do not make it self-erasing.
--
-- Apply via scripts/apply_sql.sh (Management API).

BEGIN;

-- ------------------------------------------------- health view: give it a CASE arm
CREATE OR REPLACE VIEW public.task_queue_health AS
WITH cfg AS (SELECT * FROM public.task_queue_alert_state WHERE id)
SELECT t.id,
       t.title,
       t.status,
       t.target,
       t.claimed_by,
       t.created_at,
       t.updated_at,
       CASE
         WHEN t.status = 'failed'                                   THEN 'failed'
         -- review_needed added 2026-08-15 (118). It was scanned but unmatched, so
         -- reason was NULL and the row read as healthy. Retired status: any occurrence
         -- is now itself the finding, with no age threshold — there is no reader that
         -- would ever move it, so waiting rot_days before saying so buys nothing.
         WHEN t.status IN ('blocked','escalated','expired','pending_eval','review_needed')
                                                                    THEN 'attention'
         WHEN t.status IN ('claimed','in_progress_agent')
              AND now() - t.claimed_at > make_interval(hours => cfg.stuck_claim_hours)
                                                                    THEN 'stuck_claim'
         WHEN t.status IN ('ready','pending')
              AND now() - t.created_at > make_interval(days => cfg.rot_days)
                                                                    THEN 'rotted'
         WHEN t.status = 'pending_jeff_action'
              AND now() - t.created_at > make_interval(days => cfg.jeff_action_days)
                                                                    THEN 'awaiting_jeff'
       END AS reason,
       -- All ages measured from created_at. updated_at is NOT usable as a staleness
       -- signal here: a bulk touch on 2026-08-11 reset it across every open row, which
       -- would have rendered 106-day-old rot as age_days = 0. Likewise the rot predicate
       -- deliberately ignores claimed_at -- tasks that were claimed once and fell back to
       -- 'ready' matched neither the claimed_at IS NULL rot test nor the stuck-claim test,
       -- so they were invisible to both.
       EXTRACT(day FROM now() - t.created_at)::int AS age_days
  FROM public.task_queue t, cfg
 WHERE t.status NOT IN ('completed','cancelled','archived');

COMMENT ON VIEW public.task_queue_health IS
  'Tasks needing attention: failures, blocked/escalated/review_needed, claims stuck past '
  'stuck_claim_hours, ready/pending rot past rot_days, pending_jeff_action past '
  'jeff_action_days. review_needed is a RETIRED status (118) -- any row carrying it is '
  'reported on sight. age_days is measured from created_at -- updated_at is bulk-touched '
  'and cannot be trusted. Thresholds live in task_queue_alert_state. reason IS NULL means healthy.';

-- ------------------------------------------- attention view: same status, same lane
CREATE OR REPLACE VIEW public.task_queue_attention AS
SELECT id,
       title,
       status,
       failure_mode,
       blocked_reason,
       attempt_count,
       max_attempts,
       source,
       target,
       claimed_by,
       parent_task_id,
       escalated_at,
       expires_at,
       created_at,
       updated_at
  FROM public.task_queue
 WHERE status = ANY (ARRAY['blocked','escalated','expired','pending_eval','review_needed'])
 ORDER BY (CASE status
             WHEN 'escalated'     THEN 1
             WHEN 'pending_eval'  THEN 2
             WHEN 'review_needed' THEN 3
             WHEN 'blocked'       THEN 4
             WHEN 'expired'       THEN 5
           END),
          COALESCE(escalated_at, updated_at) DESC;

COMMENT ON VIEW public.task_queue_attention IS
  'Open tasks a human or evaluator must move. review_needed is retired (118) and listed '
  'only so a straggler from any out-of-band writer surfaces at session start.';

COMMIT;
