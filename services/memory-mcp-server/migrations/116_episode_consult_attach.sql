-- Migration 116: give the A-MAC fifth term (outcome_utility) an actual input.
--
-- MEASURED STATE BEFORE THIS MIGRATION (2026-08-14):
--   287 agent_episodes,   1 with a non-empty memories_consulted
--   109 episodes (38%) stuck at status='in_progress', ended_at NULL, forever
--     5 of 889 active memories with outcome_utility > 0
-- refresh_memory_outcome_utility() (migration 114a) only counts consults on
-- episodes with status='completed'. Both halves of that predicate were starved.
--
-- ── Cause 1: the consult edge could not survive a session boundary ───────────
-- v5.16.0 added `consultBuffer` inside createMcpServer() (src/index.ts:1414), so
-- the recall→episode correlation only formed when `recall` and `record_episode`
-- ran in the SAME MCP session. In practice nothing pairs them: episodes are not
-- opened by the record_episode tool at all — poll_queue.py opens them directly
-- over PostgREST (start_episode(), poll_queue.py:708) and closes them the same
-- way. The MCP server never sees either end of the episode, so the buffer had
-- nothing to attach to and was discarded at session teardown.
--
-- Fix: stop holding the edge in process memory. attach_episode_consults() below
-- writes each recall's served set straight onto the caller's currently-open
-- episode row. State lives in the DB, so it survives restarts, session teardown,
-- and the fact that the opener and the recaller are different processes.
-- Scoping is preserved, not widened: the match is keyed on `agent`, so a recall
-- by one agent can never land on another agent's episode, and a time window
-- keeps a recall from attaching to a long-abandoned row.
--
-- ── Cause 2: episodes could not reach a terminal status ──────────────────────
-- poll_queue.py called end_episode(episode_id, "pending_jeff_action") and
-- end_episode(episode_id, "pending_eval") — task_queue statuses, passed into a
-- column constrained to ('in_progress','completed','failed','partial'). Every
-- such close-out was rejected 23514 and swallowed by end_episode's best-effort
-- except, e.g.:
--   Aug 13 16:25:26 claude-queue-poll[1832574]: HTTP 400 on PATCH agent_episodes
--     ...violates check constraint "agent_episodes_status_check"
-- 49 of 107 episodes in the last 30 days sit at in_progress while their
-- task_queue row reached 'completed'. The status, ended_at, summary AND outcome
-- of those runs were all lost in the same rejected PATCH.
--
-- The constraint is right and stays as it is — a task-queue status has no
-- business in an episode enum. poll_queue.py is fixed to map its gate statuses
-- onto 'partial', and end_episode now coerces any unknown status rather than
-- silently dropping the whole close-out. The backfill below closes the rows the
-- bug stranded so they stop shadowing the "most recent open episode" lookup.

BEGIN;

-- ── attach_episode_consults ─────────────────────────────────────────────────
-- Union `p_ids` into the newest open episode for `p_agent`, if one is open
-- inside `p_window`. Returns the episode id it attached to, or NULL when the
-- agent has no open episode — the NULL case is the common one for ad-hoc recall
-- outside a queued task run and is not an error.
CREATE OR REPLACE FUNCTION public.attach_episode_consults(
  p_agent  text,
  p_ids    uuid[],
  p_window interval DEFAULT '6 hours'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_agent IS NULL OR p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  -- Newest open episode for THIS agent only. The agent predicate is what keeps
  -- the per-caller scoping the in-process buffer used to get for free.
  SELECT e.id INTO v_id
  FROM agent_episodes e
  WHERE e.agent = p_agent
    AND e.status = 'in_progress'
    AND e.started_at > now() - p_window
  ORDER BY e.started_at DESC
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Dedup by first appearance and cap the array. A long task can recall dozens
  -- of times; without the cap a single episode's array grows without bound and
  -- dilutes every memory in it. Earliest consults win — they are the ones the
  -- run actually built on.
  UPDATE agent_episodes e
  SET memories_consulted = (
        SELECT array_agg(x ORDER BY ord)
        FROM (
          SELECT x, min(ord) AS ord
          FROM unnest(coalesce(e.memories_consulted, '{}'::uuid[]) || p_ids)
               WITH ORDINALITY AS t(x, ord)
          GROUP BY x
          ORDER BY 2
          LIMIT 128
        ) s
      ),
      updated_at = now()
  WHERE e.id = v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.attach_episode_consults IS
  'Attach a recall''s served memory ids to the calling agent''s currently-open '
  'episode. Best-effort correlation signal feeding memories.outcome_utility via '
  'refresh_memory_outcome_utility() (migration 114a) — NOT an audit log. Keyed on '
  'agent so recalls cannot cross into another agent''s episode; time-windowed so '
  'they cannot land on an abandoned row. Returns NULL when no episode is open.';

GRANT EXECUTE ON FUNCTION public.attach_episode_consults TO service_role;

-- ── Backfill: close the episodes the status-CHECK bug stranded ──────────────
-- 6h is the same window attach_episode_consults uses: anything older than that
-- is not a live run, it is a row whose close-out was rejected. Marked 'partial',
-- not 'completed' — the run happened but its outcome record was destroyed with
-- the failed PATCH, and inventing a success here would feed a fabricated edge
-- into the retention score this whole migration exists to supply.
UPDATE agent_episodes
SET status   = 'partial',
    ended_at = coalesce(ended_at, updated_at, started_at),
    outcome  = coalesce(outcome,
                 'Closed by migration 116 backfill. The original close-out PATCH was '
                 'rejected by agent_episodes_status_check because poll_queue.py wrote a '
                 'task_queue status (pending_eval / pending_jeff_action) into the episode '
                 'status enum; status, ended_at, summary and outcome were lost together.'),
    updated_at = now()
WHERE status = 'in_progress'
  AND started_at < now() - interval '6 hours';

-- Re-derive the term now that terminal statuses are no longer starved.
SELECT public.refresh_memory_outcome_utility();

COMMIT;

-- ─── Verification (run after applying) ──────────────────────────────────────
--   SELECT status, count(*) FROM agent_episodes GROUP BY status;
--     -> expect 0 in_progress older than 6h
--   SELECT count(*) FROM agent_episodes
--    WHERE created_at > now() - interval '1 day'
--      AND array_length(memories_consulted, 1) > 0;
--     -> expect materially above 0 once queued tasks run through the poller
--   SELECT count(*) FROM memories WHERE outcome_utility > 0;
