-- 105_supersedes_edge_direction_repair.sql
-- TIER 1 (research 2026-08-04): repair the supersedes lineage graph.
--
-- WHAT THE RESEARCH GOT WRONG, AND WHAT IS ACTUALLY BROKEN
--   The 2026-08-04 writeup reported "ZERO supersedes rows in memory_links" and
--   proposed making supersede_memory() write an edge. Both halves are wrong: it
--   counted memory_links.link_type (semantic 940 / temporal 126) rather than
--   memory_links.relationship, and supersede_memory() has written an edge since
--   migration 048. Grouping by relationship shows 126 rows of relationship
--   ='supersedes', carried on link_type='temporal'.
--
--   The real defect is direction, and it is worse than an absence because the graph
--   reads as populated. Of 126 supersedes edges:
--     * 91 point BACKWARDS. Something (an agent via add_memory_link, not any
--       script in this repo) wrote the monthly consolidation edges as
--       "Research Digest - 2026-06" -> "Daily ... 2026-06-15", i.e. source
--       SUPERSEDES target, while supersede_memory()'s convention — set by
--       migration 048 and relied on by every consumer — is source IS SUPERSEDED
--       BY target. The daily's memories.superseded_by column points at the digest
--       correctly; only the edge is inverted. So the lineage graph says the live
--       digest is the dead row and the retired daily is current truth.
--     * 6 are chain artifacts: supersede_memory() rewires ALL inbound links from
--       the old row to the new one, including inbound 'supersedes' edges. When A
--       was superseded by B and B is later superseded by C, the rewire invents
--       A -> C while A.superseded_by is still B. All 6 are weekly-ref rolling
--       snapshots and all 6 already have their correct edge.
--
--   Why this went unnoticed: every consumer reads memory_links direction-agnostically
--   (hop1/hop2 spreading activation joins `ml.source_id = s.id OR ml.target_id = s.id`;
--   contradiction_scan unions both orientations). Retrieval therefore cannot see the
--   inversion — which is also why this repair is provenance-only and moves no
--   retrieval metric. Provenance reconstruction, the thing arXiv:2606.24535 calls
--   "provenance collapse", is exactly what direction-agnostic reads cannot do.
--
-- ORDER MATTERS: fix the function first so the rewire stops minting new chain
-- artifacts, then repair the data, then install the guard that keeps it repaired.

-- ── 1. Stop rewiring lineage edges ─────────────────────────────────────────────
-- A 'supersedes' edge is a historical claim about one specific pair, not a citation
-- that should follow the head. Rewiring it produces A->C edges that contradict
-- A.superseded_by. The chain stays walkable via memories.superseded_by and
-- resolve_memory_head() (migration 063), which is what that function is for.
CREATE OR REPLACE FUNCTION public.supersede_memory(
  p_old_id uuid,
  p_new_id uuid,
  p_reason text DEFAULT NULL::text,
  p_heuristic text DEFAULT 'last_writer_wins'::text
)
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

  -- Column first: the direction guard below reads memories.superseded_by, so the
  -- edge insert at the bottom must happen after this UPDATE.
  UPDATE memories
     SET superseded_by = p_new_id, is_active = false, updated_at = now()
   WHERE id = p_old_id;

  WITH inbound AS (
    SELECT source_id, relationship, COALESCE(link_type, 'semantic') AS link_type, COALESCE(strength, 0.5) AS strength
    FROM memory_links
    WHERE target_id = p_old_id
      AND source_id <> p_new_id
      AND relationship <> 'supersedes'   -- migration 105: lineage edges are not citations
  )
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  SELECT source_id, p_new_id, relationship, link_type, strength FROM inbound
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
  GET DIAGNOSTICS v_rewired = ROW_COUNT;

  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  VALUES (p_old_id, p_new_id, 'supersedes', 'temporal', 1.0,
          jsonb_build_object('resolution_heuristic', p_heuristic, 'reason', p_reason))
  ON CONFLICT (source_id, target_id, relationship)
    DO UPDATE SET metadata = COALESCE(memory_links.metadata, '{}'::jsonb)
                             || jsonb_build_object('resolution_heuristic', p_heuristic);

  BEGIN
    INSERT INTO memory_log (memory_id, action, details)
    VALUES (p_old_id, 'supersede', jsonb_build_object(
      'superseded_by', p_new_id, 'reason', p_reason, 'resolution_heuristic', p_heuristic));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN QUERY SELECT p_old_id, p_new_id, v_rewired;
END;
$function$;

COMMENT ON FUNCTION public.supersede_memory(uuid, uuid, text, text) IS
  'Non-destructive supersession. Sets memories.superseded_by / is_active=false, rewires inbound NON-lineage links to the new row, and writes a supersedes edge oriented old -> new. Migration 105 stopped it rewiring inbound supersedes edges, which minted A->C edges contradicting A.superseded_by.';

-- ── 2. Flip the 91 inverted edges ──────────────────────────────────────────────
-- Identified strictly: an edge target->source exists whose TARGET's superseded_by
-- points back at the edge's SOURCE. That is unambiguous — the column is the
-- authority, the edge is the thing that disagrees with it.
WITH inverted AS (
  SELECT l.id AS link_id, l.source_id AS wrong_src, l.target_id AS wrong_tgt,
         l.strength, l.metadata
  FROM memory_links l
  JOIN memories m ON m.id = l.target_id
  WHERE l.relationship = 'supersedes'
    AND m.superseded_by = l.source_id
    AND NOT EXISTS (
      SELECT 1 FROM memory_links c
      WHERE c.source_id = l.target_id AND c.target_id = l.source_id
        AND c.relationship = 'supersedes'
    )
), ins AS (
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  SELECT wrong_tgt, wrong_src, 'supersedes', 'temporal', COALESCE(strength, 1.0),
         COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'resolution_heuristic', 'last_writer_wins',
           'reason', 'migration 105: re-oriented an inverted supersedes edge; memories.superseded_by is the authority',
           'direction_repaired', true)
  FROM inverted
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING
  RETURNING 1
)
DELETE FROM memory_links WHERE id IN (SELECT link_id FROM inverted);

-- ── 3. Drop the 6 chain artifacts ──────────────────────────────────────────────
-- Only where the correct edge already exists, so nothing is lost: these are pure
-- duplicates pointing at the wrong generation of a rolling snapshot.
DELETE FROM memory_links l
USING memories m
WHERE l.relationship = 'supersedes'
  AND m.id = l.source_id
  AND m.superseded_by IS NOT NULL
  AND m.superseded_by <> l.target_id
  AND EXISTS (
    SELECT 1 FROM memory_links c
    WHERE c.source_id = l.source_id AND c.target_id = m.superseded_by
      AND c.relationship = 'supersedes'
  );

-- ── 4. Backfill genuinely missing edges ────────────────────────────────────────
-- Any row whose superseded_by is set but has no edge in EITHER orientation. These
-- are supersessions applied by a direct column write that never went through
-- supersede_memory() at all.
INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength, metadata)
SELECT m.id, m.superseded_by, 'supersedes', 'temporal', 1.0,
       jsonb_build_object(
         'resolution_heuristic', 'last_writer_wins',
         'reason', 'migration 105: backfilled from memories.superseded_by — supersession recorded without an edge',
         'backfilled', true)
FROM memories m
WHERE m.superseded_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_links l
    WHERE l.relationship = 'supersedes'
      AND l.source_id = m.id AND l.target_id = m.superseded_by
  )
ON CONFLICT (source_id, target_id, relationship) DO NOTHING;

-- ── 5. The guard ───────────────────────────────────────────────────────────────
-- BEFORE INSERT only, on purpose: merge_memories() re-points links with UPDATE and
-- must not be blocked mid-merge, and the repair above is already consistent.
--
-- This rejects rather than auto-flips. An inverted edge written by an agent that
-- never set memories.superseded_by is not a direction typo to silently correct —
-- it is a supersession that never happened, and quietly inventing one would be the
-- same provenance fabrication this migration exists to undo. The exception names
-- the tool that does it correctly.
CREATE OR REPLACE FUNCTION public.enforce_supersedes_edge_direction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src_head uuid;
  v_tgt_head uuid;
BEGIN
  IF NEW.relationship IS DISTINCT FROM 'supersedes' THEN
    RETURN NEW;
  END IF;

  SELECT superseded_by INTO v_src_head FROM memories WHERE id = NEW.source_id;
  IF v_src_head = NEW.target_id THEN
    RETURN NEW;                       -- correct: source IS SUPERSEDED BY target
  END IF;

  SELECT superseded_by INTO v_tgt_head FROM memories WHERE id = NEW.target_id;
  IF v_tgt_head = NEW.source_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'supersedes edge is inverted: memories.superseded_by says % is superseded by %, not the reverse',
      DETAIL  = format('attempted %s -> %s', NEW.source_id, NEW.target_id),
      HINT    = 'The edge reads "source IS SUPERSEDED BY target". Swap the arguments, or call supersede_memory(p_old_id, p_new_id) which writes it correctly.';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'supersedes edge has no matching memories.superseded_by',
    DETAIL  = format('attempted %s -> %s, but memories.superseded_by for the source is %s',
                     NEW.source_id, NEW.target_id, COALESCE(v_src_head::text, 'NULL')),
    HINT    = 'Do not write lineage edges directly with add_memory_link. Call supersede_memory(p_old_id, p_new_id), which sets the column and the edge together.';
END;
$$;

DROP TRIGGER IF EXISTS memory_links_supersedes_direction ON public.memory_links;
CREATE TRIGGER memory_links_supersedes_direction
  BEFORE INSERT ON public.memory_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supersedes_edge_direction();

COMMENT ON FUNCTION public.enforce_supersedes_edge_direction() IS
  'Rejects supersedes edges that disagree with memories.superseded_by. INSERT-only so merge_memories() UPDATEs are unaffected. Migration 105, 2026-08-04.';

-- ── 6. Standing integrity check ────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.supersedes_edge_integrity AS
SELECT
  (SELECT count(*) FROM memories WHERE superseded_by IS NOT NULL)                AS superseded_rows,
  (SELECT count(*) FROM memory_links WHERE relationship = 'supersedes')          AS supersedes_edges,
  (SELECT count(*) FROM memories m WHERE m.superseded_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.relationship = 'supersedes'
                       AND l.source_id = m.id AND l.target_id = m.superseded_by)) AS rows_missing_edge,
  (SELECT count(*) FROM memory_links l JOIN memories m ON m.id = l.target_id
     WHERE l.relationship = 'supersedes' AND m.superseded_by = l.source_id)       AS inverted_edges,
  (SELECT count(*) FROM memory_links l JOIN memories m ON m.id = l.source_id
     WHERE l.relationship = 'supersedes'
       AND m.superseded_by IS DISTINCT FROM l.target_id)                          AS orphan_edges;

COMMENT ON VIEW public.supersedes_edge_integrity IS
  'Lineage-graph health: all four counters must be 0 except superseded_rows/supersedes_edges, which should track each other. Migration 105, 2026-08-04.';

GRANT SELECT ON public.supersedes_edge_integrity TO anon, authenticated, service_role;
