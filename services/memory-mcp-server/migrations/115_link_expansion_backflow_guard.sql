-- 115_link_expansion_backflow_guard.sql
--
-- BACKFLOW: retired memories re-entering recall through the link graph.
--
-- WHAT WAS WRONG
--   recall's spreading-activation step (src/index.ts) expanded 1-hop links from
--   each top hit at strength >= 0.72, then fetched those targets with NO is_active
--   predicate and no bi-temporal predicate, and injected up to 5 of them into the
--   result set with a RELEVANCE BOOST (+0.1 x strength). A row that supersede_memory
--   deliberately retired could therefore be pulled back into agent context through a
--   link from a still-active row, ranked ABOVE the live row that superseded it —
--   silently bypassing both the is_active retirement path and the 108/109 bi-temporal
--   read path.
--
--   This is the recontamination failure mode in arXiv 2602.17692 (Agentic Unlearning):
--   forgotten content persisting via a DERIVED ARTIFACT (here, the link graph) and
--   re-entering through the retrieval loop. Their remedy is dependency-aware deletion
--   over a dependency graph. az-lab already HAS that graph in memory_links — it was
--   simply never consulted on retirement.
--
-- MEASURED BEFORE THE FIX (2026-08-12)
--   74 edges at or above the 0.72 activation threshold point at is_active = false rows.
--   56 of those originate from a still-active row, i.e. are actually REACHABLE:
--   15 distinct active entry points reaching 36 distinct retired rows.
--   All 194 retired rows still carry embeddings, so nothing else was holding them back.
--
-- WHY supersede_memory LEAKS
--   It rewires INBOUND edges (source -> old) by COPYING them to (source -> new), but
--   never retires the originals. The old high-strength edge survives, now pointing at a
--   row that recall is supposed to withhold. The copy is correct; the lack of cleanup
--   is the bug.
--
-- SCOPE
--   Hard forget was never affected — memory_links.target_id is ON DELETE CASCADE, so a
--   real delete takes its edges with it. This is specific to the SOFT retire path
--   (supersede_memory / is_active = false).
--
-- WHY is_active AND NOT superseded_by
--   eval/conflict_resolution_eval.py's existing STALE-PROPAGATION RESIDUE check keys on
--   `superseded_by IS NOT NULL`. That has a blind spot: 44 of 194 retired rows are
--   retired WITHOUT a superseded_by pointer (lifecycle retirement, not supersession),
--   and they carry 15 of the 74 backflow edges. Recall filters on is_active, so the
--   guard must key on is_active too or it measures a different population than the one
--   that leaks.
--
-- REMEDY: hard-downweight, not delete.
--   Edges are driven to BACKFLOW_FLOOR (0.05) rather than removed, because the edge is
--   still true lineage and the audit trail has value — supersession is non-destructive
--   by design and this stays consistent with that. 0.05 is not arbitrary: it is exactly
--   the floor conflict_resolution_eval.py's residue check already uses (`> 0.05`), so
--   driving edges TO 0.05 satisfies that metric instead of fighting it. It sits far
--   below the 0.72 activation threshold, so the edge stops activating while remaining
--   visible to anything that walks the graph deliberately.
--   Prior strength is preserved in metadata, so this is reversible and auditable.

BEGIN;

-- ── 1. supersede_memory: downweight inbound edges to the row being retired ────
-- Identical to the shipped 105/TOKI version except for the DOWNWEIGHT block, which
-- runs AFTER the rewire INSERT so the rewired copies inherit the ORIGINAL strength
-- rather than the floored one. Order is load-bearing.
CREATE OR REPLACE FUNCTION public.supersede_memory(
  p_old_id uuid, p_new_id uuid, p_reason text DEFAULT NULL::text,
  p_heuristic text DEFAULT 'last_writer_wins'::text)
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

  UPDATE memories
     SET superseded_by = p_new_id, is_active = false, updated_at = now(), valid_to = COALESCE(valid_to, now())
   WHERE id = p_old_id;

  WITH inbound AS (
    SELECT source_id, relationship, COALESCE(link_type, 'semantic') AS link_type, COALESCE(strength, 0.5) AS strength
    FROM memory_links
    WHERE target_id = p_old_id
      AND source_id <> p_new_id
      AND relationship <> 'supersedes'
  )
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  SELECT source_id, p_new_id, relationship, link_type, strength FROM inbound
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
  GET DIAGNOSTICS v_rewired = ROW_COUNT;

  -- DOWNWEIGHT (migration 115). The rewire above preserved every inbound edge by
  -- copying it onto the new row; these originals now point at a retired row and must
  -- stop activating it. 'supersedes' edges are exempt — they ARE the lineage.
  UPDATE memory_links
     SET strength = 0.05,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'backflow_downweighted_at', now(),
           'prior_strength', COALESCE(strength, 0.5),
           'downweight_reason', 'target retired by supersede_memory (migration 115)')
   WHERE target_id = p_old_id
     AND relationship <> 'supersedes'
     AND COALESCE(strength, 0.5) > 0.05;

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

-- ── 2. Measurement surface ───────────────────────────────────────────────────
-- The probe needs the number this migration is supposed to hold at zero. Defined in
-- SQL rather than in the harness so the TS read path, the write path above and the
-- regression probe are all asserting over ONE definition of "backflow".
--
-- reachable_edges is the metric that matters: an edge from an already-retired source
-- cannot activate, because a retired source can never appear in recall's top hits in
-- the first place. Total is reported alongside so a regression in the SOURCE filter
-- shows up as the two numbers diverging.
CREATE OR REPLACE FUNCTION public.link_backflow_stats(p_threshold double precision DEFAULT 0.72)
RETURNS TABLE(
  reachable_edges integer,
  total_edges integer,
  active_entry_points integer,
  reachable_retired_rows integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    count(*) FILTER (WHERE s.is_active IS NOT FALSE)::int,
    count(*)::int,
    count(DISTINCT l.source_id) FILTER (WHERE s.is_active IS NOT FALSE)::int,
    count(DISTINCT l.target_id) FILTER (WHERE s.is_active IS NOT FALSE)::int
  FROM memory_links l
  JOIN memories s ON s.id = l.source_id
  JOIN memories t ON t.id = l.target_id
  WHERE COALESCE(l.strength, 0.5) >= p_threshold
    AND l.relationship <> 'supersedes'
    AND t.is_active IS FALSE;
$function$;

GRANT EXECUTE ON FUNCTION public.link_backflow_stats(double precision) TO authenticated, service_role, anon;

-- ── 2b. Falsifier ────────────────────────────────────────────────────────────
-- A metric pinned at 0 is indistinguishable from a metric that is not wired up. This
-- codebase has already been bitten by exactly that: FCFR read 0.0000 on six
-- consecutive runs while 8 of its 9 probes were structurally unable to fail (see
-- eval/falsify_fcfr.py). link_backflow_stats() SHOULD read 0 forever, which makes it
-- the same shape of trap.
--
-- So: inject a synthetic violation (active row -> retired row, above threshold),
-- re-measure, and roll it back. The injection happens in a BEGIN/EXCEPTION block,
-- which is a SUBTRANSACTION — raising inside it undoes every row it wrote, while the
-- plpgsql variables holding the measurements survive, because those live in memory
-- rather than in the table. Nothing is left behind even if the caller crashes.
CREATE OR REPLACE FUNCTION public.link_backflow_falsify()
RETURNS TABLE(before_edges integer, after_edges integer, detects boolean)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_before int; v_after int := -1; v_active uuid; v_retired uuid;
BEGIN
  SELECT reachable_edges INTO v_before FROM link_backflow_stats();
  BEGIN
    INSERT INTO memories (type, name, description, content)
      VALUES ('reference', '__falsify_backflow_active', 'falsifier', 'synthetic active entry point')
      RETURNING id INTO v_active;
    INSERT INTO memories (type, name, description, content, is_active)
      VALUES ('reference', '__falsify_backflow_retired', 'falsifier', 'synthetic retired target', false)
      RETURNING id INTO v_retired;
    INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
      VALUES (v_active, v_retired, 'related_to', 'semantic', 0.95);

    SELECT reachable_edges INTO v_after FROM link_backflow_stats();

    -- Undo the injection. The only exit from this block.
    RAISE EXCEPTION 'link_backflow_falsify: intentional rollback';
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- subtransaction rolled back; v_after survives
  END;
  RETURN QUERY SELECT v_before, v_after, (v_after > v_before);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.link_backflow_falsify() TO authenticated, service_role;

-- ── 3. Backfill the edges that already leaked ────────────────────────────────
-- Same predicate and same floor as the trigger above, applied to every already-retired
-- target rather than just the one being retired now. Keyed on is_active (not
-- superseded_by) so the 44 lifecycle-retired rows are covered too.
UPDATE memory_links l
   SET strength = 0.05,
       metadata = COALESCE(l.metadata, '{}'::jsonb) || jsonb_build_object(
         'backflow_downweighted_at', now(),
         'prior_strength', COALESCE(l.strength, 0.5),
         'downweight_reason', 'backfill: target already retired (migration 115)')
  FROM memories t
 WHERE t.id = l.target_id
   AND t.is_active IS FALSE
   AND l.relationship <> 'supersedes'
   AND COALESCE(l.strength, 0.5) > 0.05;

-- ── 4. Record the metric on eval runs ────────────────────────────────────────
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS backflow_edges integer;
COMMENT ON COLUMN eval_runs.backflow_edges IS
  'link_backflow_stats().reachable_edges at run time — retired memories reachable by '
  'recall spreading activation from an active row. Must be 0; non-zero means the '
  'retirement path is leaking through the link graph (migration 115).';

COMMIT;
