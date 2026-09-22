-- ---------------------------------------------------------------------------
-- 154: upsert_recurring_task re-arm clears archived_at
-- ---------------------------------------------------------------------------
-- FAILURE (found 2026-09-22 by Wren):
--   A bulk archive on 2026-09-17 20:12Z set archived_at on three recurring rows
--   (daily-ai-memory-research, weekly-rls-audit, weekly-constitution-audit).
--   The upstream producers kept firing, and upsert_recurring_task's ON CONFLICT
--   branch flipped status back to 'ready' every run — but left archived_at set.
--   Argus claims with archived_at=is.null, so the rows were 'ready' yet
--   unclaimable: zombies in the backlog, and the Discord deliveries were
--   silently dropped every day since.
--
-- FIX:
--   A producer re-arming a recurring key is the authoritative signal that the
--   schedule is live. Re-arm now clears archived_at in the same UPDATE, so a
--   row can never be both status='ready' and archived. To retire a recurring
--   schedule, disable its producer (archiving the row alone never stuck).
--
-- Body is otherwise identical to the live definition (read back 2026-09-22).
-- CREATE OR REPLACE keeps existing grants (149's anon lock-down still holds).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_recurring_task(p_recurring_key text, p_title text, p_description text, p_context jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 2, p_target text DEFAULT NULL::text, p_source text DEFAULT 'cowork'::text, p_tags text[] DEFAULT '{}'::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    archived_at   = NULL,  -- 154: a re-armed row must be claimable
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
$function$;

-- Backfill: un-archive the recurring rows the re-arm already put back to 'ready'.
UPDATE public.task_queue
   SET archived_at = NULL
 WHERE recurring = true
   AND status = 'ready'
   AND archived_at IS NOT NULL;
