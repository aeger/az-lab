-- 148_downweight_edges_on_retirement.sql
-- 2026-09-03 premise_hold task fix (option b)
--
-- PROBLEM: episodic_distill.py creates edges to rows, then retires those rows.
-- The creation-time guard (activeLinkTargets) misses this link-then-retire ordering.
-- The distiller also bypasses MCP, so application-layer guards don't bind it.
--
-- FIX: On retirement, downweight all inbound edges to the retired memory to 0.050
-- (the same floor applied to above-threshold violations). This is:
--   - writer-agnostic (works for any create_link caller)
--   - ordering-proof (fixes the violation at the moment it occurs)
--   - semantically correct (retirement is when the edge becomes dead weight)

CREATE OR REPLACE FUNCTION public.retire_cold_memories(p_limit integer DEFAULT 25, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(id uuid, name text, standing_value double precision, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean;
  v_retired_ids uuid[];
BEGIN
  SELECT value INTO v_enabled FROM public.memory_lifecycle_settings WHERE key = 'autoretire_enabled';

  IF NOT p_dry_run AND NOT COALESCE(v_enabled, false) THEN
    RAISE NOTICE 'retire_cold_memories: autoretire_enabled is false - forcing dry run.';
    p_dry_run := true;
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT c.id, c.name, c.standing_value
    FROM public.memory_retirement_candidates c
    WHERE c.in_duplicate_cluster = false
    ORDER BY c.standing_value ASC
    LIMIT p_limit
  ), done AS (
    UPDATE memories m
    SET is_active = false, retired_at = now(),
        retire_reason = 'lifecycle: cold tier, never accessed, aged >90d (migration 065)'
    FROM picked p
    WHERE m.id = p.id AND NOT p_dry_run
    RETURNING m.id
  ), edge_downweight AS (
    UPDATE memory_links ml
    SET strength = 0.050
    FROM done d
    WHERE ml.target_id = d.id AND ml.strength > 0.050 AND NOT p_dry_run
    RETURNING d.id
  )
  SELECT p.id, p.name, p.standing_value,
         CASE WHEN p_dry_run THEN 'DRY RUN: would retire' ELSE 'RETIRED (soft)' END
  FROM picked p;
END;
$function$
;
