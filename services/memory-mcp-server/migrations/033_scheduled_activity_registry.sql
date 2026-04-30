-- Migration 033: scheduled_activity registry — unified scheduler control plane
-- ──────────────────────────────────────────────────────────────────────────────
-- Aggregates ALL scheduled work in az-lab into one queryable + writable table:
--   • systemd timers (~20 active) — claude-r2-backup, episodic-distill, etc.
--   • user crontab entries
--   • CCR triggers on claude.ai (ai-memory-research, weekly-rls-audit, etc.)
--   • always-on agent loops (sage, argus)
--   • task_queue rows with recurring=true (post-migration 031)
--
-- The dashboard Scheduled tab (Phase 2) reads from this. The control daemon
-- (Phase 3) watches for status/schedule/enabled/paused changes and writes
-- them back to the native scheduler config. This migration is read-only —
-- daemon arrives in a follow-up.
--
-- Apply via Supabase dashboard SQL editor:
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

BEGIN;

CREATE TABLE IF NOT EXISTS public.scheduled_activity (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable identifier — slug, e.g. 'breakthrough-watch', 'claude-r2-backup',
  -- 'agent-loop-sage'. Unique across all kinds. Used as the join key in
  -- audit log and as the primary identity in dashboard URLs.
  name          TEXT         NOT NULL UNIQUE,
  display_name  TEXT,
  description   TEXT,

  -- Which scheduler runs this work. Determines how the control daemon
  -- writes changes back: systemd unit edit, crontab regen, CCR trigger
  -- update, agent_loop hot-reload, or task_queue UPDATE.
  kind          TEXT         NOT NULL CHECK (kind IN (
                                'systemd',
                                'cron',
                                'ccr_trigger',
                                'agent_loop',
                                'task_queue_recurring'
                             )),

  -- Schedule expression — varies by kind:
  --   systemd:    OnCalendar string ("Mon 9:00 UTC") or OnUnitActiveSec ("5min")
  --   cron:       5-field cron expression
  --   ccr_trigger: 5-field cron expression
  --   agent_loop: interval ("30s")
  --   task_queue_recurring: cron expression from upstream upsert
  schedule      TEXT         NOT NULL,
  schedule_tz   TEXT         NOT NULL DEFAULT 'UTC',

  -- Lifecycle state. enabled=false means tombstoned (kept for history but
  -- never fires). paused_at non-null means temporarily paused (e.g. during
  -- maintenance window) — control daemon should leave the schedule entry
  -- in place but skip dispatch.
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  paused_at     TIMESTAMPTZ,
  pause_reason  TEXT,

  -- Pointer back to where the actual scheduler config lives. Required so
  -- the control daemon can find the unit/crontab line/trigger ID/etc.
  -- Shape varies by kind:
  --   systemd:                 {"unit": "claude-r2-backup.service"}
  --   cron:                    {"line": "*/15 * * * * cp /home/...", "user": "almty1"}
  --   ccr_trigger:             {"trigger_id": "trig_01...", "owner_account": "almty1"}
  --   agent_loop:              {"service": "sage.service", "loop_var": "POLL_INTERVAL"}
  --   task_queue_recurring:    {"task_id": "uuid", "recurring_key": "..."}
  source_ref    JSONB        NOT NULL,

  -- Run state (cache; the source of truth is the native scheduler).
  -- Updated by the seeder/resync (read) and the control daemon (write-back).
  last_run_at         TIMESTAMPTZ,
  last_status         TEXT CHECK (last_status IN (
                          'success',
                          'failure',
                          'running',
                          'skipped',
                          'unknown',
                          NULL
                      )),
  last_result_summary TEXT,
  next_run_at         TIMESTAMPTZ,
  run_count           INTEGER NOT NULL DEFAULT 0,

  -- Recent run history. Capped at last 50 entries by the seeder. Each entry
  -- shape: {run_at, status, result_summary, duration_sec, notes, source_id}
  -- For task_queue_recurring kind, this is a mirror of task_queue.runs.
  runs          JSONB        NOT NULL DEFAULT '[]'::jsonb,

  tags          TEXT[]       NOT NULL DEFAULT '{}'::text[],

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_kind
  ON public.scheduled_activity(kind);

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_enabled
  ON public.scheduled_activity(enabled, kind)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_next_run
  ON public.scheduled_activity(next_run_at)
  WHERE enabled = true AND paused_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_last_run
  ON public.scheduled_activity(last_run_at DESC NULLS LAST);

COMMENT ON TABLE public.scheduled_activity IS
  'Unified registry of every scheduler in az-lab — systemd timers, cron, '
  'CCR triggers, agent loops, task_queue recurring rows. Dashboard reads '
  'and edits here; control daemon syncs changes to native sources.';

-- ── Audit log ─────────────────────────────────────────────────────────
-- Records every change to scheduled_activity. Required for compliance
-- and for the dashboard CRUD UI to show "who changed what when". The
-- control daemon writes the actor for system-driven changes; manual UI
-- edits write 'jeff' or whoever clicked.

CREATE TABLE IF NOT EXISTS public.scheduled_activity_audit (
  id                       BIGSERIAL    PRIMARY KEY,
  scheduled_activity_id    UUID         NOT NULL REFERENCES public.scheduled_activity(id) ON DELETE CASCADE,
  scheduled_activity_name  TEXT         NOT NULL,  -- denormalized so audit survives row deletion if FK is dropped

  -- What happened. Free-form for forward compat; canonical values:
  --   'created', 'updated', 'enabled', 'disabled', 'paused', 'resumed',
  --   'schedule_changed', 'run_recorded', 'native_sync_failed'
  action                   TEXT         NOT NULL,
  actor                    TEXT,        -- 'jeff', 'wren', 'control-daemon', 'auto-seeder', etc.
  before                   JSONB,       -- partial snapshot of changed columns before
  after                    JSONB,       -- partial snapshot after
  notes                    TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_audit_target
  ON public.scheduled_activity_audit(scheduled_activity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_audit_action
  ON public.scheduled_activity_audit(action, created_at DESC);

COMMENT ON TABLE public.scheduled_activity_audit IS
  'Append-only audit trail for every change to scheduled_activity. Manual '
  'UI edits, control daemon writes, and run-status updates all land here.';

-- ── auto-touch updated_at on UPDATE ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_scheduled_activity_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduled_activity_touch ON public.scheduled_activity;
CREATE TRIGGER scheduled_activity_touch
  BEFORE UPDATE ON public.scheduled_activity
  FOR EACH ROW EXECUTE FUNCTION public.tg_scheduled_activity_touch();

-- ── RLS ───────────────────────────────────────────────────────────────
-- service_role only by default. Dashboard reads via server-side route
-- (also service_role). No anon access — these rows control execution
-- of system schedulers and shouldn't be browser-readable.

ALTER TABLE public.scheduled_activity        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_activity_audit  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "_service_role_bypass" ON public.scheduled_activity;
CREATE POLICY "_service_role_bypass" ON public.scheduled_activity
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "_service_role_bypass" ON public.scheduled_activity_audit;
CREATE POLICY "_service_role_bypass" ON public.scheduled_activity_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── helper RPCs for the control daemon ────────────────────────────────

-- record_scheduled_run(): atomic append to runs[] + last_run_at + last_status
-- Called by the seeder when it observes a new fire on the native scheduler,
-- or by individual scripts (claude-r2-backup, etc.) to self-report.
CREATE OR REPLACE FUNCTION public.record_scheduled_run(
  p_name           TEXT,
  p_status         TEXT,
  p_result_summary TEXT DEFAULT NULL,
  p_run_at         TIMESTAMPTZ DEFAULT now(),
  p_duration_sec   NUMERIC DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id   UUID;
  v_run  JSONB;
BEGIN
  v_run := jsonb_build_object(
    'run_at',          p_run_at,
    'status',          p_status,
    'result_summary',  p_result_summary,
    'duration_sec',    p_duration_sec,
    'notes',           p_notes
  );

  UPDATE public.scheduled_activity
     SET last_run_at         = p_run_at,
         last_status         = p_status,
         last_result_summary = p_result_summary,
         run_count           = run_count + 1,
         -- cap runs[] to last 50 entries
         runs                = (
                                 CASE WHEN jsonb_array_length(runs) >= 50
                                      THEN (runs - 0) || v_run
                                      ELSE runs || v_run
                                 END
                               )
   WHERE name = p_name
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'scheduled_activity % not found', p_name;
  END IF;

  INSERT INTO public.scheduled_activity_audit
    (scheduled_activity_id, scheduled_activity_name, action, actor, after, notes)
  VALUES
    (v_id, p_name, 'run_recorded', 'native', v_run, p_notes);
END;
$$;

-- upsert_scheduled_activity(): single-call helper for the seeder. Idempotent
-- by name. Returns the id.
CREATE OR REPLACE FUNCTION public.upsert_scheduled_activity(
  p_name          TEXT,
  p_kind          TEXT,
  p_schedule      TEXT,
  p_source_ref    JSONB,
  p_display_name  TEXT DEFAULT NULL,
  p_description   TEXT DEFAULT NULL,
  p_tags          TEXT[] DEFAULT '{}'::text[],
  p_enabled       BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id     UUID;
  v_before JSONB;
  v_action TEXT;
BEGIN
  SELECT id, jsonb_build_object(
    'schedule', schedule,
    'enabled',  enabled,
    'source_ref', source_ref,
    'display_name', display_name,
    'description', description,
    'tags', tags
  ) INTO v_id, v_before
  FROM public.scheduled_activity WHERE name = p_name;

  INSERT INTO public.scheduled_activity
    (name, kind, schedule, source_ref, display_name, description, tags, enabled)
  VALUES
    (p_name, p_kind, p_schedule, p_source_ref, p_display_name, p_description, p_tags, p_enabled)
  ON CONFLICT (name) DO UPDATE SET
    kind         = EXCLUDED.kind,
    schedule     = EXCLUDED.schedule,
    source_ref   = EXCLUDED.source_ref,
    display_name = COALESCE(EXCLUDED.display_name, public.scheduled_activity.display_name),
    description  = COALESCE(EXCLUDED.description,  public.scheduled_activity.description),
    tags         = EXCLUDED.tags,
    enabled      = EXCLUDED.enabled
  RETURNING id INTO v_id;

  v_action := CASE WHEN v_before IS NULL THEN 'created' ELSE 'updated' END;

  INSERT INTO public.scheduled_activity_audit
    (scheduled_activity_id, scheduled_activity_name, action, actor, before, after)
  VALUES
    (v_id, p_name, v_action, 'auto-seeder', v_before, jsonb_build_object(
      'schedule', p_schedule, 'enabled', p_enabled, 'source_ref', p_source_ref,
      'display_name', p_display_name, 'description', p_description, 'tags', p_tags
    ));

  RETURN v_id;
END;
$$;

-- Bucket-2 policy: revoke EXECUTE from anon, authenticated. Only service_role.
REVOKE EXECUTE ON FUNCTION public.record_scheduled_run(TEXT, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_scheduled_activity(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT[], BOOLEAN) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_scheduled_activity_touch() FROM anon, authenticated;

COMMIT;

-- Verification:
--   SELECT name, kind, schedule, last_run_at FROM scheduled_activity
--   ORDER BY last_run_at DESC NULLS LAST LIMIT 5;
--
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('record_scheduled_run','upsert_scheduled_activity','tg_scheduled_activity_touch');
