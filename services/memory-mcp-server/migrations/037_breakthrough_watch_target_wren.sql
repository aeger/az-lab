-- Migration 037: enforce target='wren' for Discord-delivery recurring keys
-- ─────────────────────────────────────────────────────────────────────────
-- Problem: a CCR trigger on Iris's cowork side (not in this account's
-- visible trigger list) is calling upsert_recurring_task for the
-- breakthrough-watch recurring_key with an explicit p_target='cowork'.
-- This is outdated — the corrected prompt template in
-- iris_trigger_prompt_diff.md uses p_target='wren', because Wren is the
-- only agent with agent-bus send_discord access. The poll_queue filter
-- is target IN ('claude-code', 'wren'), so target='cowork' never gets
-- claimed via the proper routing path; Wren only picks it up because the
-- description starts with "Wren:" (a hint), not because of routing.
--
-- Fix: enforce a known set of Discord-delivery recurring_keys to always
-- route to 'wren', regardless of what the upstream trigger passes. This
-- is a backstop at the DB layer because the trigger source cannot be
-- edited from svc-podman-01 (lives in another claude.ai account).
--
-- Apply via apply_sql.sh.

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
  v_target text;
BEGIN
  -- Discord-delivery recurring keys must route to wren — only Wren has
  -- agent-bus send_discord. Override any upstream target value for these.
  IF p_recurring_key IN (
    'breakthrough-watch',
    'daily-ai-memory-research',
    'weekly-rls-audit',
    'weekly-constitution-audit'
  ) THEN
    v_target := 'wren';
  ELSE
    v_target := COALESCE(p_target, 'claude-code');
  END IF;

  INSERT INTO public.task_queue
    (title, description, context, priority, status, source, target, tags,
     recurring, recurring_key, last_run_at, run_count, runs)
  VALUES
    (p_title, p_description, COALESCE(p_context, '{}'::jsonb), p_priority,
     'ready', p_source, v_target, COALESCE(p_tags, '{}'::text[]),
     true, p_recurring_key, now(), 1, jsonb_build_array(v_run))
  ON CONFLICT (recurring_key) WHERE recurring = true
  DO UPDATE SET
    title         = EXCLUDED.title,
    description   = EXCLUDED.description,
    context       = EXCLUDED.context,
    priority      = EXCLUDED.priority,
    target        = v_target,
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

-- Backfill: correct the current breakthrough-watch row immediately so the
-- next poll picks it up correctly via routing (not via description hint).
UPDATE public.task_queue
SET target = 'wren', updated_at = now()
WHERE recurring_key = 'breakthrough-watch'
  AND target <> 'wren';

COMMIT;
