-- Migration 116a: concurrency correctness for attach_episode_consults.
--
-- Found by measurement minutes after 116 deployed, not by inspection. Three queued
-- research tasks were running at once, so THREE agent='wren' episodes were open
-- simultaneously, and a recall issued by run [1/3] attached to run [3/3]'s episode:
--   [consults] attached 5 to episode 504a7b16-734a-4293-a8de-ffa073f142a1
-- Same agent, so nothing leaked across trust boundaries — but the edge was
-- mis-attributed, and a mis-attributed edge is precisely the correlated-trace false
-- promotion this signal is meant to avoid. `agent` alone is not a unique key while
-- the queue poller has overlapping runs.
--
-- Two new params let the MCP server bind one session to one episode:
--   p_episode_id — attach to THIS episode, skipping the lookup (sticky re-attach,
--                  re-validated as still open and still owned by the same agent, so
--                  a closed episode can never be reopened by a late recall)
--   p_exclude    — episodes already claimed by other live MCP sessions
-- The claim registry lives in the server (src/index.ts, episodeClaims) keyed by
-- episode id with a 6h TTL. It holds NO consult ids, so it is a keyed claim table,
-- not the cross-caller consult buffer that 116's design comment rules out.

BEGIN;

DROP FUNCTION IF EXISTS public.attach_episode_consults(text, uuid[], interval);

CREATE OR REPLACE FUNCTION public.attach_episode_consults(
  p_agent      text,
  p_ids        uuid[],
  p_window     interval DEFAULT '6 hours',
  p_episode_id uuid     DEFAULT NULL,
  p_exclude    uuid[]   DEFAULT '{}'::uuid[]
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

  IF p_episode_id IS NOT NULL THEN
    SELECT e.id INTO v_id
    FROM agent_episodes e
    WHERE e.id = p_episode_id AND e.agent = p_agent AND e.status = 'in_progress';
  ELSE
    SELECT e.id INTO v_id
    FROM agent_episodes e
    WHERE e.agent = p_agent
      AND e.status = 'in_progress'
      AND e.started_at > now() - p_window
      AND NOT (e.id = ANY(coalesce(p_exclude, '{}'::uuid[])))
    ORDER BY e.started_at DESC
    LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

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
  'Attach a recall''s served memory ids to the calling agent''s open episode. '
  'Best-effort correlation signal feeding memories.outcome_utility via '
  'refresh_memory_outcome_utility() (migration 114a) — NOT an audit log. Keyed on '
  'agent so a recall cannot cross into another agent''s episode; p_episode_id / '
  'p_exclude let one MCP session bind to one episode so concurrent same-agent runs '
  'do not steal each other''s edges. Returns NULL when no episode is open.';

GRANT EXECUTE ON FUNCTION public.attach_episode_consults TO service_role;

COMMIT;

-- ─── Open question this does NOT settle ─────────────────────────────────────
-- refresh_memory_outcome_utility() counts consults on status='completed' only.
-- poll_queue.py's gate paths (pending_eval / pending_jeff_action) now close as
-- 'partial', so those runs still contribute no utility — 49 of 107 episodes in the
-- last 30 days took a gate path. Mapping them to 'completed' would credit consulted
-- memories for work that Iris has not evaluated yet and Jeff has not approved. The
-- right fix is for the EVAL outcome to close the episode, which belongs with the
-- episode-lifecycle work, not here. Flagged, deliberately not decided.
