-- Migration 136: task_queue time/data gates — first-class `waiting` status
--
-- WHY: the queue had no way to express "do not touch this task until <time> /
-- until <condition>". Task ff8c500d (08-26 eval read-back) needed data that
-- would not exist until the next nightly run; the only tools available were
-- `blocked` (a dead end nothing ever un-blocks) and `pending_jeff_action`
-- (which routed a machine-gated task into Jeff's attention queue). A one-off
-- systemd timer (unblock-eval-readback) was hand-built as a workaround.
--
-- WHAT:
--   1. task_queue.not_before  — earliest instant the poller may claim the task.
--      Enforced in poll_queue.claim_next_task (claim filter) and by the
--      sweep_waiting_tasks release sweep.
--   2. task_queue.unblock_condition — machine-checkable gate, evaluated by
--      poll_queue.sweep_waiting_tasks every 5-min poll. Typed, no free-form SQL:
--        {"type": "time"}                                    → not_before alone
--        {"type": "tasks_complete", "task_ids": ["<uuid>"]}  → all listed tasks
--                                                              completed/archived
--        {"type": "file_newer_than", "path": "~/x.log",
--         "after": "2026-08-25T05:00:54Z"}                   → local file mtime
--                                                              newer than `after`
--      When both not_before and a condition are set, BOTH must pass.
--      blocked_by_task_ids (migration 015) acts as an implicit tasks_complete
--      gate — until now it was display-only.
--   3. status 'waiting' — "gated and healthy": not claimable, not failed, not
--      Jeff's problem. `blocked` keeps meaning "needs intervention".
--   4. task_queue_health arms for waiting and paused (both previously fell
--      through to the unclassified ELSE — the migration-118 failure mode where
--      reason NULL reads as healthy):
--        waiting_no_gate  — waiting with no gate at all (misfiled; nothing will
--                           ever release it)
--        waiting_overdue  — pure time gate passed >1h ago and the sweeper has
--                           not released it (sweeper down?)
--        paused_stale     — paused with no touch for > rot_days
--
-- Apply via apply_migration (ledger) — do NOT direct-SQL without inserting the
-- ledger row (see system_rules.scoring_function_migration_required).

-- ─── 1+2: gate columns ────────────────────────────────────────────────────────

ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS not_before timestamptz;
ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS unblock_condition jsonb;

COMMENT ON COLUMN task_queue.not_before IS
  'Earliest instant the poller may claim this task. NULL = no time gate. Enforced in poll_queue.py claim filter and release sweep.';
COMMENT ON COLUMN task_queue.unblock_condition IS
  'Machine-checkable release gate for status=waiting, evaluated by poll_queue.sweep_waiting_tasks. Types: time | tasks_complete | file_newer_than. See migration 136 header.';

-- ─── 3: allow status 'waiting' ────────────────────────────────────────────────

ALTER TABLE task_queue DROP CONSTRAINT task_queue_status_check;
ALTER TABLE task_queue ADD CONSTRAINT task_queue_status_check CHECK (
  status = ANY (ARRAY[
    'backlog','ready','in_progress_agent','in_progress_jeff','pending_jeff_action',
    'blocked','paused','completed','cancelled','archived','hand_back','pending',
    'claimed','failed','escalated','expired','delegated','pending_eval','waiting'
  ])
);

-- ─── 4: task_queue_health — waiting + paused arms ────────────────────────────
-- Full view re-stated (CREATE OR REPLACE) with the two new status arms in both
-- the `reason` and `decision` CASEs, plus not_before/gate_type appended as new
-- trailing columns. Everything else is byte-equivalent to the live definition.

CREATE OR REPLACE VIEW task_queue_health AS
 WITH cfg AS (
         SELECT task_queue_alert_state.id,
            task_queue_alert_state.enabled,
            task_queue_alert_state.stuck_claim_hours,
            task_queue_alert_state.rot_days,
            task_queue_alert_state.jeff_action_days,
            task_queue_alert_state.digest_hours,
            task_queue_alert_state.last_signature,
            task_queue_alert_state.last_check_at,
            task_queue_alert_state.last_alert_at,
            task_queue_alert_state.alert_count
           FROM task_queue_alert_state
          WHERE task_queue_alert_state.id
        ), open_ids AS (
         SELECT task_queue.id
           FROM task_queue
          WHERE (task_queue.status <> ALL (ARRAY['completed'::text, 'cancelled'::text, 'archived'::text]))
        )
 SELECT t.id,
    t.title,
    t.status,
    t.target,
    t.claimed_by,
    t.created_at,
    t.updated_at,
        CASE
            WHEN (t.status = 'failed'::text) THEN 'failed'::text
            WHEN (t.status = ANY (ARRAY['blocked'::text, 'escalated'::text, 'expired'::text, 'pending_eval'::text, 'review_needed'::text])) THEN 'attention'::text
            WHEN ((t.status = ANY (ARRAY['claimed'::text, 'in_progress_agent'::text])) AND ((now() - t.claimed_at) > make_interval(hours => cfg.stuck_claim_hours))) THEN 'stuck_claim'::text
            WHEN ((t.status = ANY (ARRAY['ready'::text, 'pending'::text])) AND ((now() - t.created_at) > make_interval(days => cfg.rot_days))) THEN 'rotted'::text
            WHEN ((t.status = 'waiting'::text) AND (t.not_before IS NULL) AND (t.unblock_condition IS NULL) AND (COALESCE(array_length(t.blocked_by_task_ids, 1), 0) = 0)) THEN 'waiting_no_gate'::text
            WHEN ((t.status = 'waiting'::text) AND (t.not_before IS NOT NULL) AND (t.not_before < (now() - '01:00:00'::interval)) AND ((t.unblock_condition IS NULL) OR ((t.unblock_condition ->> 'type'::text) = 'time'::text))) THEN 'waiting_overdue'::text
            WHEN ((t.status = 'paused'::text) AND ((now() - t.updated_at) > make_interval(days => cfg.rot_days))) THEN 'paused_stale'::text
            WHEN ((t.status = 'pending_jeff_action'::text) AND (cls.severity_class IS NOT NULL)) THEN cls.severity_class
            WHEN ((t.status = 'pending_jeff_action'::text) AND ((now() - t.created_at) > make_interval(days => cfg.jeff_action_days))) THEN 'awaiting_jeff'::text
            ELSE NULL::text
        END AS reason,
    (EXTRACT(day FROM (now() - t.created_at)))::integer AS age_days,
    cls.severity_class,
    p.c_ack AS result_present,
        CASE
            WHEN (t.status = 'failed'::text) THEN format('FINDING failed — tested status; status=failed is reported on sight (no age threshold)'::text)
            WHEN (t.status = ANY (ARRAY['blocked'::text, 'escalated'::text, 'expired'::text, 'pending_eval'::text, 'review_needed'::text])) THEN format('FINDING attention — tested status; %L is in the attention set (no age threshold)'::text, t.status)
            WHEN (t.status = ANY (ARRAY['claimed'::text, 'in_progress_agent'::text])) THEN format('%s — tested age-since-claim; %s vs stuck_claim_hours=%sh'::text,
            CASE
                WHEN ((now() - t.claimed_at) > make_interval(hours => cfg.stuck_claim_hours)) THEN 'FINDING stuck_claim'::text
                ELSE 'hold'::text
            END,
            CASE
                WHEN (t.claimed_at IS NULL) THEN 'claimed_at NULL (untestable)'::text
                ELSE ((round((EXTRACT(epoch FROM (now() - t.claimed_at)) / 3600.0), 1))::text || 'h'::text)
            END, cfg.stuck_claim_hours)
            WHEN (t.status = ANY (ARRAY['ready'::text, 'pending'::text])) THEN format('%s — tested age-since-created; %sd vs rot_days=%sd'::text,
            CASE
                WHEN ((now() - t.created_at) > make_interval(days => cfg.rot_days)) THEN 'FINDING rotted'::text
                ELSE 'hold'::text
            END, (EXTRACT(day FROM (now() - t.created_at)))::integer, cfg.rot_days)
            WHEN (t.status = 'waiting'::text) THEN format('%s — tested gate; not_before=%s, condition=%s, deps=%s'::text,
            CASE
                WHEN ((t.not_before IS NULL) AND (t.unblock_condition IS NULL) AND (COALESCE(array_length(t.blocked_by_task_ids, 1), 0) = 0)) THEN 'FINDING waiting_no_gate'::text
                WHEN ((t.not_before IS NOT NULL) AND (t.not_before < (now() - '01:00:00'::interval)) AND ((t.unblock_condition IS NULL) OR ((t.unblock_condition ->> 'type'::text) = 'time'::text))) THEN 'FINDING waiting_overdue'::text
                ELSE 'hold'::text
            END, COALESCE((t.not_before)::text, '(none)'::text), COALESCE((t.unblock_condition ->> 'type'::text), '(none)'::text), COALESCE(array_length(t.blocked_by_task_ids, 1), 0))
            WHEN (t.status = 'paused'::text) THEN format('%s — tested age-since-update; %sd vs rot_days=%sd'::text,
            CASE
                WHEN ((now() - t.updated_at) > make_interval(days => cfg.rot_days)) THEN 'FINDING paused_stale'::text
                ELSE 'hold'::text
            END, (EXTRACT(day FROM (now() - t.updated_at)))::integer, cfg.rot_days)
            WHEN ((t.status = 'pending_jeff_action'::text) AND (cls.severity_class IS NOT NULL)) THEN format('FINDING %s — tested class [premise_hold=%s, result_present=%s(%s chars), security_gate=%s, blocks_open_gap=%s]; age %sd IGNORED (class bypasses jeff_action_days=%sd)'::text, cls.severity_class, p.c_prem, p.c_ack, length(COALESCE(btrim(t.result), ''::text)), p.c_sec, p.c_gap, (EXTRACT(day FROM (now() - t.created_at)))::integer, cfg.jeff_action_days)
            WHEN (t.status = 'pending_jeff_action'::text) THEN format('%s — no class matched [premise_hold=false, result_present=false, security_gate=%s, blocks_open_gap=%s]; fell through to age axis: %sd vs jeff_action_days=%sd'::text,
            CASE
                WHEN ((now() - t.created_at) > make_interval(days => cfg.jeff_action_days)) THEN 'FINDING awaiting_jeff'::text
                ELSE 'hold'::text
            END, p.c_sec, p.c_gap, (EXTRACT(day FROM (now() - t.created_at)))::integer, cfg.jeff_action_days)
            ELSE format('hold — status %L matches no CASE arm; scanned but unclassified (this is the 118 failure mode: reason NULL reads as healthy)'::text, t.status)
        END AS decision,
    t.not_before,
    (t.unblock_condition ->> 'type'::text) AS gate_type
   FROM (((task_queue t
     CROSS JOIN cfg)
     CROSS JOIN LATERAL ( SELECT (COALESCE(btrim(t.result), ''::text) <> ''::text) AS c_ack,
            COALESCE(((t.title ~* '\[KILL SWITCH\]'::text) OR (t.title ~* '(^|[^[:alnum:]])(security|credential|secret|rls|injection|exposed|leak)([^[:alnum:]]|$)'::text) OR (t.failure_mode = 'silent_agent'::text)), false) AS c_sec,
            (EXISTS ( SELECT 1
                   FROM open_ids o
                  WHERE ((o.id <> t.id) AND (((COALESCE(t.title, ''::text) || ' '::text) || COALESCE(t.description, ''::text)) ~ (('(^|[^[:alnum:]])'::text || "left"((o.id)::text, 8)) || '([^[:alnum:]]|$)'::text))))) AS c_gap,
            COALESCE((t.tags && ARRAY['premise-hold'::text]), false) AS c_prem) p)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (t.status <> 'pending_jeff_action'::text) THEN NULL::text
                    WHEN p.c_sec THEN 'security_gate'::text
                    WHEN p.c_prem THEN 'premise_hold'::text
                    WHEN p.c_gap THEN 'blocks_open_gap'::text
                    WHEN p.c_ack THEN 'ack_only'::text
                    ELSE NULL::text
                END AS severity_class) cls)
  WHERE (t.status <> ALL (ARRAY['completed'::text, 'cancelled'::text, 'archived'::text]));
