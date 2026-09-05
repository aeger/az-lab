-- 129: allow a Cowork (claude.ai) scheduled routine to register in
--      scheduled_activity, so its run-log has a home every agent can reach.
-- ────────────────────────────────────────────────────────────────────
-- MEASURED 2026-08-24 (first-hand, this database + svc-podman-01):
--   The Cowork routine "daily-email-digest" appends its per-run tally to
--     C:\Users\almty\OneDrive\Documents\Claude\Scheduled\daily-email-digest\run-log.jsonl
--   and reads that file back for the morning digest. Cowork scheduled runs are
--   HEADLESS CLOUD sessions -- no desktop bridge, no local files -- so the path
--   is unreachable from the only surface that actually fires the trigger. Only
--   Atlas (Windows) can touch C:\... ; Wren (Linux) cannot either. The run-log
--   was therefore write-only-in-theory and unwritten in practice.
--
-- WHY NOT re-home the trigger to the Windows workstation instead:
--   That trades an unreachable path for an unreachable HOST -- the digest fires
--   07:00 MST and the workstation is not guaranteed awake. It also keeps the
--   log readable by exactly one agent. scheduled_activity is already the
--   registry every agent reads over the Supabase MCP.
--
-- WHY NOT reuse an existing kind:
--   'ccr_trigger' is the closest fit and is deliberately handler=None today,
--   but KIND_HANDLERS marks it "warn-only for now; requires claude.ai PAT"
--   (scheduled_control_daemon.py:506). When that handler lands it will
--   reconcile ccr_trigger rows against the CCR API, and a Cowork routine
--   parked under that kind would read as an orphan. Give Cowork its own kind.
--
-- SAFETY: reconcile_one() (scheduled_control_daemon.py:511-514) does
--   KIND_HANDLERS.get(row["kind"]) and returns early when the handler is None,
--   so an unregistered kind is inert -- the daemon will not try to materialise
--   a Cowork routine as a systemd unit or crontab line.
--
-- This migration only WIDENS a CHECK; no existing row changes.

ALTER TABLE public.scheduled_activity
  DROP CONSTRAINT scheduled_activity_kind_check;

ALTER TABLE public.scheduled_activity
  ADD CONSTRAINT scheduled_activity_kind_check
  CHECK (kind = ANY (ARRAY[
    'systemd'::text,
    'cron'::text,
    'ccr_trigger'::text,
    'agent_loop'::text,
    'task_queue_recurring'::text,
    'cowork_scheduled'::text
  ]));
