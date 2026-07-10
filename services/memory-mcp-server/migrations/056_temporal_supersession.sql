-- 056_temporal_supersession.sql
-- Temporal supersession lane for the daily contradiction scan.
-- Ref: 2606.24535 (Governed Shared Memory) REC — "wire memory_conflicts for
-- temporal supersession; mark superseded rows." Runs ASYNC of the write-time
-- near-duplicate gate (the daily batch, per the MemClaw ordering gotcha).
--
-- SAFETY: acts ONLY on unambiguous sets — same writer_agent + IDENTICAL name +
-- same type, >1 live copy, non-dated-journal names. These are re-statements /
-- rolling-snapshot references (e.g. weekly-ref:*) where only the newest is
-- current truth. Fuzzy-similarity supersession is deliberately NOT done here:
-- 8/8 high-sim same-writer candidates in prod were legitimate rolling snapshots,
-- so sim-based auto-marking would bury valid history. supersede_memory() is
-- soft + reversible (sets superseded_by/is_active=false, rewires links, logs).

-- 1. Allow the new conflict_type for audit rows.
ALTER TABLE public.memory_conflicts DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;
ALTER TABLE public.memory_conflicts ADD CONSTRAINT memory_conflicts_conflict_type_check
  CHECK (conflict_type = ANY (ARRAY[
    'contradiction','overlap','stale','duplicate','near_duplicate',
    'concurrent_write','temporal_supersession']));

-- 2. Detection + marking function.
CREATE OR REPLACE FUNCTION public.detect_temporal_supersession(p_max_groups integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_groups    integer := 0;
  v_superseded integer := 0;
  g RECORD;
  o RECORD;
  v_newest uuid;
  v_newest_ts timestamptz;
BEGIN
  FOR g IN
    SELECT name, writer_agent, type
    FROM memories
    WHERE superseded_by IS NULL
      AND coalesce(expires_at,'infinity'::timestamptz) > now()
      AND writer_agent IS NOT NULL
      AND name !~ '\d{4}-\d{2}-\d{2}'   -- dated journal entries are a legit series
    GROUP BY name, writer_agent, type
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT p_max_groups
  LOOP
    v_groups := v_groups + 1;
    -- Newest live copy in the group = current truth.
    SELECT id, created_at INTO v_newest, v_newest_ts
    FROM memories
    WHERE name = g.name AND writer_agent = g.writer_agent AND type = g.type
      AND superseded_by IS NULL
      AND coalesce(expires_at,'infinity'::timestamptz) > now()
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    FOR o IN
      SELECT id, created_at FROM memories
      WHERE name = g.name AND writer_agent = g.writer_agent AND type = g.type
        AND superseded_by IS NULL
        AND coalesce(expires_at,'infinity'::timestamptz) > now()
        AND id <> v_newest
    LOOP
      PERFORM public.supersede_memory(o.id, v_newest,
        format('temporal_supersession: same-name %s "%s" by %s superseded by newest copy (%s)',
          g.type, g.name, g.writer_agent, to_char(v_newest_ts,'YYYY-MM-DD')));
      v_superseded := v_superseded + 1;

      INSERT INTO memory_conflicts
        (memory_a_id, memory_b_id, conflict_type, description, detected_by,
         resolved, resolved_at, resolved_by, resolution_notes)
      VALUES (o.id, v_newest, 'temporal_supersession',
        format('Same-name %s "%s" (%s): older copy superseded by newest.',
          g.type, g.name, g.writer_agent),
        'temporal-supersession', true, now(), 'temporal-supersession',
        'auto-resolved: soft supersede via supersede_memory (reversible)')
      ON CONFLICT (memory_a_id, memory_b_id) DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'groups_examined', v_groups,
    'rows_superseded', v_superseded,
    'live_superseded_total', (SELECT count(*) FROM memories WHERE superseded_by IS NOT NULL)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.detect_temporal_supersession(integer) TO anon, authenticated, service_role;
