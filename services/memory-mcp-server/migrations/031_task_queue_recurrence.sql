-- Migration 031: scheduled-task recurrence support on task_queue
-- ─────────────────────────────────────────────────────────────────
-- Problem: Recurring CCR triggers (breakthrough watch, daily research, etc.)
-- INSERT a new task_queue row on every fire, producing duplicate-titled
-- "scheduled tasks" the dashboard can't aggregate. Today there are 13
-- duplicates of "Send breakthrough alert to Discord" alone.
--
-- Solution: Add recurrence columns to task_queue. Triggers UPSERT keyed on
-- recurring_key. poll_queue.py + dashboard treat a recurring row as the
-- canonical entry, with each fire appended to runs[].
--
-- Apply via Supabase dashboard SQL editor:
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

BEGIN;

ALTER TABLE public.task_queue
  ADD COLUMN IF NOT EXISTS recurring     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_key text,
  ADD COLUMN IF NOT EXISTS last_run_at   timestamptz,
  ADD COLUMN IF NOT EXISTS run_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runs          jsonb       NOT NULL DEFAULT '[]'::jsonb;

-- Unique on recurring_key so UPSERT works. Partial index — non-recurring rows
-- can have recurring_key = NULL without conflicting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_queue_recurring_key
  ON public.task_queue(recurring_key)
  WHERE recurring = true;

-- Index for efficient "find canonical recurring tasks" queries from dashboard
CREATE INDEX IF NOT EXISTS idx_task_queue_recurring_last_run
  ON public.task_queue(recurring, last_run_at DESC)
  WHERE recurring = true;

COMMENT ON COLUMN public.task_queue.recurring IS
  'true if this row is a canonical scheduled task — fires update it in place rather than inserting new rows';
COMMENT ON COLUMN public.task_queue.recurring_key IS
  'Stable identifier for UPSERT, e.g. "daily-ai-memory-research", "breakthrough-watch"';
COMMENT ON COLUMN public.task_queue.last_run_at IS
  'Timestamp of the most recent fire — overwrites on each upsert';
COMMENT ON COLUMN public.task_queue.run_count IS
  'How many times this scheduled task has fired';
COMMENT ON COLUMN public.task_queue.runs IS
  'Append-only JSONB array of {run_at, result, notes, status} records, one per fire';

-- ── RPC helpers ───────────────────────────────────────────────────────────
-- record_recurring_run_result(): atomically write the result of the latest fire
-- back into runs[<last>] without race conditions. Called by poll_queue.py when
-- a recurring task completes.

CREATE OR REPLACE FUNCTION public.record_recurring_run_result(
  p_task_id uuid,
  p_result  text,
  p_status  text DEFAULT 'completed',
  p_notes   text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last_idx int;
  cur_runs jsonb;
BEGIN
  SELECT runs, GREATEST(jsonb_array_length(runs) - 1, 0)
    INTO cur_runs, last_idx
    FROM public.task_queue
    WHERE id = p_task_id AND recurring = true;

  IF cur_runs IS NULL THEN
    RAISE EXCEPTION 'task % is not recurring or not found', p_task_id;
  END IF;

  UPDATE public.task_queue
  SET
    status = p_status,
    result = p_result,
    runs = jsonb_set(
      runs,
      ARRAY[last_idx::text],
      (runs->last_idx)
        || jsonb_build_object(
             'result',       p_result,
             'status',       p_status,
             'completed_at', to_jsonb(now()),
             'notes',        to_jsonb(p_notes)
           ),
      false
    )
  WHERE id = p_task_id;
END;
$$;

-- upsert_recurring_task(): single-call helper for CCR triggers. Inserts a new
-- canonical row keyed on recurring_key, or updates an existing one (resetting
-- to 'ready' and appending a {run_at, status:'ready'} entry to runs[]).
-- Returns the task id.

CREATE OR REPLACE FUNCTION public.upsert_recurring_task(
  p_recurring_key text,
  p_title         text,
  p_description   text,
  p_context       jsonb   DEFAULT '{}'::jsonb,
  p_priority      int     DEFAULT 2,
  p_target        text    DEFAULT NULL,
  p_source        text    DEFAULT 'cowork',
  p_tags          text[]  DEFAULT '{}'::text[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_run jsonb := jsonb_build_object('run_at', to_jsonb(now()), 'status', 'ready', 'result', null, 'notes', null);
BEGIN
  INSERT INTO public.task_queue
    (title, description, context, priority, status, source, target, tags,
     recurring, recurring_key, last_run_at, run_count, runs)
  VALUES
    (p_title, p_description, COALESCE(p_context, '{}'::jsonb), p_priority,
     'ready', p_source, p_target, COALESCE(p_tags, '{}'::text[]),
     true, p_recurring_key, now(), 1, jsonb_build_array(v_run))
  ON CONFLICT (recurring_key) WHERE recurring = true
  DO UPDATE SET
    title         = EXCLUDED.title,
    description   = EXCLUDED.description,
    context       = EXCLUDED.context,
    priority      = EXCLUDED.priority,
    target        = COALESCE(EXCLUDED.target, public.task_queue.target),
    tags          = EXCLUDED.tags,
    status        = 'ready',
    claimed_by    = NULL,
    claimed_at    = NULL,
    result        = NULL,
    error         = NULL,
    last_run_at   = now(),
    run_count     = public.task_queue.run_count + 1,
    runs          = public.task_queue.runs || v_run,
    updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Lock down to service_role only — same policy as the rest of the SECURITY DEFINER
-- functions (Bucket 2 of the security score remediation).
REVOKE EXECUTE ON FUNCTION public.record_recurring_run_result(uuid, text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_recurring_task(text, text, text, jsonb, int, text, text, text[]) FROM anon, authenticated;

COMMIT;

-- Verification:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='task_queue'
--     AND column_name IN ('recurring','recurring_key','last_run_at','run_count','runs');
--   SELECT proname FROM pg_proc WHERE proname IN ('record_recurring_run_result','upsert_recurring_task');
