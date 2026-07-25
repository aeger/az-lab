-- 075_task_queue_stamp_archived_at.sql
--
-- Root-cause fix for task_queue archive drift.
--
-- Problem: nothing stamped `archived_at` when a task reached a terminal status.
-- Five agents (wren, iris, atlas, cowork, desktop) write completions by hand and
-- none of them set it, so terminal rows accumulated with `archived_at IS NULL`
-- forever. By 2026-07-25 that was 1,292 rows out of 1,944 -- backfilled manually
-- that day, but it would have rebuilt immediately without this trigger.
--
-- `archived_at IS NULL` is used as the "open work" filter by:
--   scripts/atlas-queue-check.sh
--   services/sentinel/src/collectors/atlas-tasks.ts
--   services/lumen-extension/src/background/supabase.ts
-- so the column needs to mean what it says.
--
-- NOTE: poll_queue.py filters on `status` only and never reads `archived_at`,
-- so this changes nothing for the poller. It is correctness, not performance.

CREATE OR REPLACE FUNCTION public.task_queue_stamp_archived_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Recurring templates park at status='completed' between fires and are reset
  -- to 'ready' by the upstream UPSERT. Stamping them would hide them from the
  -- three consumers above and silently kill the recurring schedule.
  IF NEW.recurring IS TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('completed', 'cancelled', 'archived') THEN
    -- Never overwrite a stamp the caller set explicitly.
    IF NEW.archived_at IS NULL THEN
      NEW.archived_at := now();
    END IF;

  ELSIF TG_OP = 'UPDATE'
        AND OLD.status IN ('completed', 'cancelled', 'archived')
        AND NEW.archived_at IS NOT NULL
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    -- Task reopened (terminal -> non-terminal, e.g. a retry or an un-cancel).
    -- Clear the stale stamp so it shows up as open work again. The
    -- IS NOT DISTINCT FROM guard means we only clear a stamp we owned --
    -- if this same statement set archived_at deliberately, we respect it.
    NEW.archived_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.task_queue_stamp_archived_at() IS
  'Keeps task_queue.archived_at in sync with terminal status. Skips recurring templates.';

DROP TRIGGER IF EXISTS trg_task_queue_archive_on_terminal ON public.task_queue;

CREATE TRIGGER trg_task_queue_archive_on_terminal
  BEFORE INSERT OR UPDATE ON public.task_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.task_queue_stamp_archived_at();
