-- Migration 070: materialize memory_duplicate_pairs.
--
-- WHY: as a plain view it was an O(n^2) pgvector self-join (802 active rows ->
-- ~320k cosine comparisons, ~10k surviving pairs). Fine from a psql session, but
-- memory_health_snapshot() reads it THREE times (dup_rows + both retirement
-- counts) and blew PostgREST's statement timeout with 57014 on the very first
-- call from memory_health_report.py.
--
-- Near-duplicate structure changes only when memories are written, so computing it
-- per-request was always wrong. Refresh is driven by the nightly lifecycle job
-- (memory_lifecycle_pass.py -> refresh_memory_duplicate_pairs()).

DROP VIEW IF EXISTS public.memory_retirement_candidates;
DROP VIEW IF EXISTS public.memory_duplicate_pairs;

CREATE MATERIALIZED VIEW public.memory_duplicate_pairs AS
SELECT a.id AS id_a, b.id AS id_b, a.name AS name_a, b.name AS name_b,
       1 - (a.embedding <=> b.embedding) AS similarity
FROM memories a
JOIN memories b
  ON a.id < b.id AND a.embedding <=> b.embedding < 0.08
WHERE COALESCE(a.is_active, true) IS NOT FALSE
  AND COALESCE(b.is_active, true) IS NOT FALSE
  AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mdp_id_a ON public.memory_duplicate_pairs(id_a);
CREATE INDEX IF NOT EXISTS idx_mdp_id_b ON public.memory_duplicate_pairs(id_b);

COMMENT ON MATERIALIZED VIEW public.memory_duplicate_pairs IS
  'Near-duplicate memory pairs at cosine >= 0.92 (migrations 065/070). Materialized: the underlying self-join is O(n^2) and timed out PostgREST. Refresh via refresh_memory_duplicate_pairs().';

CREATE OR REPLACE VIEW public.memory_retirement_candidates AS
WITH dup AS (
  SELECT id_a AS id FROM public.memory_duplicate_pairs
  UNION
  SELECT id_b FROM public.memory_duplicate_pairs
)
SELECT s.id, s.name, s.type, s.trust_tier, s.access_count,
  s.created_at, s.age_days, s.standing_value, s.staleness_candidate,
  (d.id IS NOT NULL) AS in_duplicate_cluster,
  CASE WHEN d.id IS NOT NULL THEN 'hold: consolidate cluster first'
       ELSE 'eligible: cold + never-accessed + aged' END AS disposition
FROM public.memory_standing s
LEFT JOIN dup d ON d.id = s.id
WHERE s.memory_tier = 'cold'
  AND s.access_count = 0
  AND s.created_at < now() - interval '90 days'
ORDER BY s.standing_value ASC;

COMMENT ON VIEW public.memory_retirement_candidates IS
  'Soft-retirement candidates (migrations 065/070). Cold tier ONLY per AMV-L. in_duplicate_cluster=true rows are held back for consolidation and are NOT retired.';

CREATE OR REPLACE FUNCTION public.refresh_memory_duplicate_pairs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  REFRESH MATERIALIZED VIEW public.memory_duplicate_pairs;
  SELECT count(*) INTO n FROM public.memory_duplicate_pairs;
  RETURN n;
END;
$$;

GRANT SELECT ON public.memory_duplicate_pairs, public.memory_retirement_candidates TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_memory_duplicate_pairs() TO service_role;
