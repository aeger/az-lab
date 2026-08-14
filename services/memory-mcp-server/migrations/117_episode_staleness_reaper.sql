-- Migration 117: a continuous backstop for the episode lifecycle, and a number
-- that makes an unbounded open-episode count visible.
--
-- RELATIONSHIP TO MIGRATION 116 (applied 2026-08-14 16:26:40Z, same day)
--   116 found and fixed the CAUSE of the 109-row leak: poll_queue.py wrote
--   task_queue statuses ('pending_eval', 'pending_jeff_action') into an episode
--   status column constrained to four values, so every such close-out PATCH was
--   rejected 23514 and swallowed by end_episode's best-effort except. 116 maps
--   those statuses to 'partial' at the writer and backfilled the stranded rows.
--   That fix is correct and this migration does not touch it.
--
--   What 116 cannot cover is the class where NO close-out code runs at all:
--   the poller is SIGKILLed, the host reboots mid-task, run_claude's timeout
--   takes the parent down, `systemctl --user stop` lands between start_episode()
--   and end_episode(). There is no PATCH to fix in those cases because there is
--   no PATCH. start_episode() opens the row over PostgREST at poll_queue.py:708
--   and nothing else is responsible for it, so the row stays in_progress with a
--   NULL ended_at forever. The 08-11 19:48Z reboot is a live example of the
--   shape: it left orphaned podman healthcheck timers behind (commit 34d6d8f),
--   and it would have stranded any episode open at that moment the same way.
--
--   116's backfill is a one-shot UPDATE inside a migration; it closes today's
--   109 rows and then never runs again. This migration makes the same predicate
--   a scheduled sweep, so the invariant holds continuously instead of once.
--
-- WHY THE INVARIANT MATTERS BEYOND TIDINESS
--   attach_episode_consults() (116) resolves "the newest open episode for this
--   agent" to hang recall consults on. A stale in_progress row is not inert —
--   it is the newest open episode until something closes it, so it silently
--   captures another run's consults and feeds them to the wrong episode. 116
--   bounds that with a 6h window; this reaper uses the SAME 6h threshold, so an
--   episode can never be open longer than the window that lookup trusts. The
--   two agree by construction rather than by coincidence.
--
-- WHY 6 HOURS
--   Measured over the 178 episodes that have ever reached ended_at:
--     p50 1.4 min | p90 7.2 min | p99 24.8 min | max 26.7 min
--   No episode in the table's history has ever legitimately stayed open past
--   27 minutes. 6h is ~14x the p99 and matches 116's window exactly.
--
-- WHY 'abandoned' AND NOT 'partial'
--   116 reasoned that a task-queue status has no business in the episode enum,
--   and that stands. 'abandoned' is not a task_queue status — it is a genuine
--   episode lifecycle outcome, and it carries information 'partial' would
--   destroy. A 116-backfilled row means "the run finished and we know its
--   close-out was rejected". A reaped row means "we do not know what happened
--   to this run" — that is the honest forensic record, and conflating the two
--   would make the post-hoc replay story (OWASP ASI06 layers 4-5) lie about
--   which traces are trustworthy.
--
--   Neither status enters refresh_memory_outcome_utility(), which counts only
--   status='completed' (migration 114a). An abandoned episode contributes no
--   outcome edge, which is correct: it has no outcome.

BEGIN;

-- ── Step 1: allow a terminal status for "we do not know" ────────────────────
-- Rewritten, not dropped-and-guessed: the four existing values are preserved
-- exactly as 116 left them and 'abandoned' is added alongside.
ALTER TABLE public.agent_episodes
  DROP CONSTRAINT IF EXISTS agent_episodes_status_check;

ALTER TABLE public.agent_episodes
  ADD CONSTRAINT agent_episodes_status_check
  CHECK (status = ANY (ARRAY[
    'in_progress'::text,
    'completed'::text,
    'failed'::text,
    'partial'::text,
    'abandoned'::text
  ]));

-- ── Step 2: the reaper ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reap_stale_episodes(
  p_threshold interval DEFAULT '6 hours',
  p_dry_run   boolean  DEFAULT false
)
RETURNS TABLE (reaped integer, oldest_age_hours numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reaped integer := 0;
  v_oldest numeric;
BEGIN
  -- The activity clock is greatest(started_at, updated_at), NOT started_at
  -- alone. attach_episode_consults() bumps updated_at on every recall it lands,
  -- so a genuinely long-running task that is still recalling keeps its row
  -- alive and is never reaped out from under itself. Keying on started_at would
  -- have killed exactly the runs that are working hardest.
  SELECT max(EXTRACT(EPOCH FROM (now() - greatest(started_at, updated_at))) / 3600)
    INTO v_oldest
  FROM agent_episodes
  WHERE status = 'in_progress'
    AND greatest(started_at, updated_at) < now() - p_threshold;

  IF p_dry_run THEN
    SELECT count(*) INTO v_reaped
    FROM agent_episodes
    WHERE status = 'in_progress'
      AND greatest(started_at, updated_at) < now() - p_threshold;
    RETURN QUERY SELECT v_reaped, round(coalesce(v_oldest, 0), 2);
    RETURN;
  END IF;

  WITH reaped AS (
    UPDATE agent_episodes
    SET status   = 'abandoned',
        -- Stamp the last moment we have evidence the run was alive, not now().
        -- now() would claim the episode ran until the reaper fired and make
        -- every duration metric derived from ended_at wrong by up to 6 hours.
        ended_at = coalesce(ended_at, greatest(started_at, updated_at)),
        outcome  = coalesce(outcome,
                     'Reaped by reap_stale_episodes: still in_progress ' ||
                     to_char(EXTRACT(EPOCH FROM (now() - greatest(started_at, updated_at))) / 3600, 'FM999990.0') ||
                     'h past its last activity. No close-out ever ran, so the '
                     'outcome of this run is unknown — it was not observed to '
                     'succeed or fail. Usual cause is the poller process dying '
                     'between start_episode() and end_episode() (kill, reboot, '
                     'timeout). Not the migration-116 class, which is a rejected '
                     'close-out PATCH and is recorded as ''partial''.'),
        updated_at = now()
    WHERE status = 'in_progress'
      AND greatest(started_at, updated_at) < now() - p_threshold
    RETURNING 1
  )
  SELECT count(*) INTO v_reaped FROM reaped;

  RETURN QUERY SELECT v_reaped, round(coalesce(v_oldest, 0), 2);
END;
$function$;

COMMENT ON FUNCTION public.reap_stale_episodes IS
  'Give a terminal status to agent_episodes rows left in_progress past a '
  'threshold. Backstop for the case migration 116 cannot reach: the close-out '
  'code never runs at all (process kill, reboot, timeout). Keys on '
  'greatest(started_at, updated_at) so an actively-recalling episode survives. '
  'Marks ''abandoned'', which is deliberately distinct from 116''s ''partial'' — '
  'partial means the outcome record was lost, abandoned means the outcome is '
  'unknown. Neither feeds refresh_memory_outcome_utility().';

GRANT EXECUTE ON FUNCTION public.reap_stale_episodes TO service_role;

-- ── Step 3: the alertable surface ───────────────────────────────────────────
-- An unbounded in_progress count was invisible: nothing counted it, so 38% of
-- the table could sit open for three months without raising anything. Same
-- lesson as the frozen podman healthchecks (34d6d8f) — the failure mode is
-- that the thing which should be written stops being written, so the check has
-- to look at the ABSENCE, not at a status field.
CREATE OR REPLACE VIEW public.agent_episode_health AS
SELECT
  count(*) FILTER (WHERE status = 'in_progress')                    AS open_total,
  count(*) FILTER (WHERE status = 'in_progress'
                     AND greatest(started_at, updated_at)
                         < now() - interval '6 hours')              AS open_stale,
  round(coalesce(max(EXTRACT(EPOCH FROM (now() - greatest(started_at, updated_at))) / 3600)
        FILTER (WHERE status = 'in_progress'), 0), 2)               AS oldest_open_hours,
  count(*) FILTER (WHERE status = 'abandoned'
                     AND updated_at > now() - interval '24 hours')  AS abandoned_24h,
  count(*) FILTER (WHERE status = 'abandoned')                      AS abandoned_total,
  count(*)                                                          AS episodes_total,
  -- Share of the table that has never reached a terminal status. This is the
  -- headline number the task was opened against: it was 0.38 on 2026-08-14.
  round(count(*) FILTER (WHERE status = 'in_progress')::numeric
        / greatest(count(*), 1), 4)                                 AS open_fraction
FROM agent_episodes;

COMMENT ON VIEW public.agent_episode_health IS
  'One-row alertable summary of agent_episodes lifecycle health. open_stale > 0 '
  'means the reaper has not run or something is re-opening rows faster than it '
  'closes them; a rising abandoned_24h means runs are dying before close-out '
  'and the cause is upstream of the episode table.';

GRANT SELECT ON public.agent_episode_health TO service_role;

COMMIT;

-- ─── Verification (run after applying) ──────────────────────────────────────
--   SELECT * FROM agent_episode_health;
--     -> open_stale = 0 once the timer has fired once
--   SELECT * FROM reap_stale_episodes('6 hours', true);   -- dry run, no writes
--   SELECT status, count(*) FROM agent_episodes GROUP BY status ORDER BY 2 DESC;
