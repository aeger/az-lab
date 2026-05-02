-- Migration 035: fix upsert_recurring_task target preservation bug
-- ─────────────────────────────────────────────────────────────────
-- Problem: Recurring tasks (e.g. breakthrough-watch) get stuck after Sage
-- flips them to review_needed with target=jeff. Subsequent CCR fires call
-- upsert_recurring_task which currently does:
--   target = COALESCE(EXCLUDED.target, public.task_queue.target)
-- so the trigger's NULL target falls through to the existing target=jeff,
-- preserving the stuck routing. poll_queue's filter is target IN
-- (claude-code, wren), so the fire never gets claimed and the alert never
-- goes out. Sage then re-flips it to review_needed and the cycle repeats.
--
-- Fix: on conflict, default to 'claude-code' if the trigger doesn't pass an
-- explicit target. The trigger is the source of truth for routing on each
-- fire; preserved-state from the previous run is a bug, not a feature.
--
-- Apply via apply_sql.sh (Management API).

BEGIN;

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
     'ready', p_source, COALESCE(p_target, 'claude-code'), COALESCE(p_tags, '{}'::text[]),
     true, p_recurring_key, now(), 1, jsonb_build_array(v_run))
  ON CONFLICT (recurring_key) WHERE recurring = true
  DO UPDATE SET
    title         = EXCLUDED.title,
    description   = EXCLUDED.description,
    context       = EXCLUDED.context,
    priority      = EXCLUDED.priority,
    target        = COALESCE(EXCLUDED.target, 'claude-code'),
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

REVOKE EXECUTE ON FUNCTION public.upsert_recurring_task(text, text, text, jsonb, int, text, text, text[]) FROM anon, authenticated;

COMMIT;
