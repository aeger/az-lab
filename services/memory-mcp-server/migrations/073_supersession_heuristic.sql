-- 073_supersession_heuristic.sql
-- TOKI-style labeled resolution heuristic on supersession (2026-07-24 research rec 3).
-- Ref: TOKI (arXiv 2606.06240) — reframes contradiction resolution as write-time
-- concurrency control; every supersede must (a) preserve the LOSING fact in an audit
-- row with provenance, and (b) be tagged with WHICH heuristic resolved it.
--
-- Live-state before this migration (verified 2026-07-24):
--   (a) PRESERVE — already satisfied. supersede_memory() (048) soft-supersedes:
--       superseded_by set, is_active=false (row kept, not deleted), inbound links
--       rewired, a memory_links 'supersedes' edge written, and a memory_log
--       action='supersede' audit row with {superseded_by, reason}. The losing fact
--       is preserved with provenance.
--   (b) LABEL — the GAP. The resolving heuristic was only implied in a free-text
--       `reason` string. There was no structured field to query "how was this
--       resolved" or to audit heuristic mix over time.
--
-- This migration adds the label as first-class data:
--   * supersede_memory() gains p_heuristic (default 'last_writer_wins') and stamps it
--     into the memory_log audit row AND the memory_links.metadata of the supersedes edge.
--   * memory_conflicts gains a resolution_heuristic column.
--   * detect_temporal_supersession() passes 'last_writer_wins' explicitly (newest copy
--     wins = last-writer-wins in TOKI terms) and records it on the audit row.
--
-- Heuristic vocabulary (TOKI's four operators):
--   last_writer_wins | evidence_weighted_merge | await_confirmation | per_rule_policy
--
-- BONUS FIX-FORWARD (found while implementing): supersede_memory()'s memory_log audit
-- insert targeted a `details` column that does NOT exist on memory_log, so the whole
-- INSERT raised and was swallowed by its `EXCEPTION WHEN OTHERS THEN NULL` — the audit
-- row was never written. Adding memory_log.details (and memory_links.metadata) below
-- makes that audit insert actually persist, so TOKI point (a) is genuinely satisfied
-- and not merely intended.

-- 0. Schema the audit trail needs (additive, nullable — no backfill, no RLS surface).
ALTER TABLE public.memory_links ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE public.memory_log   ADD COLUMN IF NOT EXISTS details  jsonb;

-- 1. Structured heuristic label on the conflict audit row.
ALTER TABLE public.memory_conflicts
  ADD COLUMN IF NOT EXISTS resolution_heuristic text
  CHECK (resolution_heuristic IS NULL OR resolution_heuristic = ANY (ARRAY[
    'last_writer_wins','evidence_weighted_merge','await_confirmation','per_rule_policy']));

-- 2. supersede_memory() — add p_heuristic, stamp it into the audit trail.
--    Drop the 3-arg signature and replace with a 4-arg version whose new param has a
--    DEFAULT, so existing 3-arg callers (SQL and PostgREST named-arg) keep working and
--    silently record 'last_writer_wins' (the historical implicit behaviour).
DROP FUNCTION IF EXISTS public.supersede_memory(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.supersede_memory(
    p_old_id uuid,
    p_new_id uuid,
    p_reason text DEFAULT NULL::text,
    p_heuristic text DEFAULT 'last_writer_wins')
 RETURNS TABLE(old_id uuid, new_id uuid, rewired_links integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rewired int := 0;
BEGIN
  IF p_old_id IS NULL OR p_new_id IS NULL THEN
    RAISE EXCEPTION 'supersede_memory: both p_old_id and p_new_id required';
  END IF;
  IF p_old_id = p_new_id THEN
    RAISE EXCEPTION 'supersede_memory: cannot supersede a memory with itself';
  END IF;
  IF p_heuristic IS NULL OR p_heuristic <> ALL (ARRAY[
       'last_writer_wins','evidence_weighted_merge','await_confirmation','per_rule_policy']) THEN
    RAISE EXCEPTION 'supersede_memory: invalid heuristic %, expected a TOKI operator', p_heuristic;
  END IF;
  PERFORM 1 FROM memories WHERE id = p_old_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: old memory % not found', p_old_id; END IF;
  PERFORM 1 FROM memories WHERE id = p_new_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: new memory % not found', p_new_id; END IF;

  -- Preserve the losing fact (soft supersede — reversible, never deleted).
  UPDATE memories
     SET superseded_by = p_new_id, is_active = false, updated_at = now()
   WHERE id = p_old_id;

  WITH inbound AS (
    SELECT source_id, relationship, COALESCE(link_type, 'semantic') AS link_type, COALESCE(strength, 0.5) AS strength
    FROM memory_links
    WHERE target_id = p_old_id AND source_id <> p_new_id
  )
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  SELECT source_id, p_new_id, relationship, link_type, strength FROM inbound
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
  GET DIAGNOSTICS v_rewired = ROW_COUNT;

  -- Provenance edge, now carrying the resolving heuristic in metadata.
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  VALUES (p_old_id, p_new_id, 'supersedes', 'temporal', 1.0,
          jsonb_build_object('resolution_heuristic', p_heuristic, 'reason', p_reason))
  ON CONFLICT (source_id, target_id, relationship)
    DO UPDATE SET metadata = COALESCE(memory_links.metadata, '{}'::jsonb)
                             || jsonb_build_object('resolution_heuristic', p_heuristic);

  -- Audit row: losing fact id + provenance + labeled heuristic.
  BEGIN
    INSERT INTO memory_log (memory_id, action, details)
    VALUES (p_old_id, 'supersede', jsonb_build_object(
      'superseded_by', p_new_id, 'reason', p_reason, 'resolution_heuristic', p_heuristic));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN QUERY SELECT p_old_id, p_new_id, v_rewired;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.supersede_memory(uuid, uuid, text, text) TO anon, authenticated, service_role;

-- 3. Temporal detector — pass the explicit heuristic and record it on the audit row.
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
      -- newest-copy-wins == last-writer-wins in TOKI terms.
      PERFORM public.supersede_memory(o.id, v_newest,
        format('temporal_supersession: same-name %s "%s" by %s superseded by newest copy (%s)',
          g.type, g.name, g.writer_agent, to_char(v_newest_ts,'YYYY-MM-DD')),
        'last_writer_wins');
      v_superseded := v_superseded + 1;

      INSERT INTO memory_conflicts
        (memory_a_id, memory_b_id, conflict_type, description, detected_by,
         resolved, resolved_at, resolved_by, resolution_notes, resolution_heuristic)
      VALUES (o.id, v_newest, 'temporal_supersession',
        format('Same-name %s "%s" (%s): older copy superseded by newest.',
          g.type, g.name, g.writer_agent),
        'temporal-supersession', true, now(), 'temporal-supersession',
        'auto-resolved: soft supersede via supersede_memory (reversible)', 'last_writer_wins')
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
