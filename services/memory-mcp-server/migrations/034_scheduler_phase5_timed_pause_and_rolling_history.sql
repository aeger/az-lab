-- Migration 034: Phase 5.1 + 5.2 — timed pause and 7-day rolling run history
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds:
--   • scheduled_activity.unpause_at — auto-clear pause when now() reaches this
--   • record_scheduled_run rewrite — 7-day rolling window instead of 50-entry FIFO
--   • Backfill: trim existing runs[] to last 7 days
--
-- Apply via scripts/apply_sql.sh (Wren self-serves DDL via the sbp_ token)

BEGIN;

-- 5.1 — timed pause column
ALTER TABLE public.scheduled_activity
  ADD COLUMN IF NOT EXISTS unpause_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scheduled_activity_unpause_at
  ON public.scheduled_activity(unpause_at)
  WHERE unpause_at IS NOT NULL;

COMMENT ON COLUMN public.scheduled_activity.unpause_at IS
  'If set, the control daemon clears paused_at automatically when now() >= unpause_at. '
  'Use for "pause for 30m/1h/until tomorrow" — UI sets paused_at AND unpause_at together.';

-- 5.2 — record_scheduled_run with 7-day rolling window
-- Replaces the 50-entry FIFO. Each call drops runs older than 7 days and
-- appends the new entry at the tail.
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
  v_id      UUID;
  v_run     JSONB;
  v_cutoff  TIMESTAMPTZ := now() - INTERVAL '7 days';
  v_kept    JSONB;
BEGIN
  v_run := jsonb_build_object(
    'run_at',          p_run_at,
    'status',          p_status,
    'result_summary',  p_result_summary,
    'duration_sec',    p_duration_sec,
    'notes',           p_notes
  );

  -- Filter existing runs to last 7 days, then append the new one.
  WITH src AS (
    SELECT runs FROM public.scheduled_activity WHERE name = p_name
  )
  SELECT COALESCE(
    (SELECT jsonb_agg(elem ORDER BY (elem->>'run_at')::timestamptz)
     FROM src, jsonb_array_elements(runs) elem
     WHERE (elem->>'run_at')::timestamptz >= v_cutoff),
    '[]'::jsonb
  )
  INTO v_kept;

  UPDATE public.scheduled_activity
     SET last_run_at         = p_run_at,
         last_status         = p_status,
         last_result_summary = p_result_summary,
         run_count           = run_count + 1,
         runs                = v_kept || v_run
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

REVOKE EXECUTE ON FUNCTION public.record_scheduled_run(TEXT, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT) FROM anon, authenticated;

-- 5.2 backfill — trim existing runs[] arrays to last 7 days
UPDATE public.scheduled_activity
   SET runs = COALESCE(
     (SELECT jsonb_agg(elem ORDER BY (elem->>'run_at')::timestamptz)
      FROM jsonb_array_elements(runs) elem
      WHERE (elem->>'run_at')::timestamptz >= now() - INTERVAL '7 days'),
     '[]'::jsonb
   )
 WHERE jsonb_array_length(runs) > 0;

COMMIT;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='scheduled_activity'
--      AND column_name='unpause_at';
--   SELECT name, jsonb_array_length(runs) AS n_runs FROM public.scheduled_activity
--    WHERE jsonb_array_length(runs) > 0 ORDER BY n_runs DESC LIMIT 5;
