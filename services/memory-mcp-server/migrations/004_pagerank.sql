-- Migration 004: PageRank scoring over Zettelkasten memory link graph
-- Adds pagerank_score column, compute_pagerank() function, and updates hybrid_recall()
-- to boost results by PageRank score.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Add pagerank_score column ────────────────────────────────────────

ALTER TABLE memories ADD COLUMN IF NOT EXISTS pagerank_score float DEFAULT 0.0;

-- ─── Step 2: Create compute_pagerank() function ───────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_pagerank(damping float DEFAULT 0.85, iterations int DEFAULT 20)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  n int;
  i int;
  updated int;
BEGIN
  -- Count total nodes
  SELECT COUNT(*) INTO n FROM memories;
  IF n = 0 THEN RETURN 0; END IF;

  -- Initialize all scores to 1/n
  UPDATE memories SET pagerank_score = 1.0 / n;

  -- Iterative PageRank computation
  FOR i IN 1..iterations LOOP
    UPDATE memories m
    SET pagerank_score = (1.0 - damping) / n + damping * COALESCE(
      (
        SELECT SUM(src.pagerank_score / out_degree.cnt)
        FROM memory_links ml
        JOIN memories src ON src.id = ml.source_id
        JOIN (
          SELECT source_id, COUNT(*) as cnt
          FROM memory_links
          GROUP BY source_id
        ) out_degree ON out_degree.source_id = ml.source_id
        WHERE ml.target_id = m.id
      ), 0.0
    );
  END LOOP;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_pagerank(float, int) TO service_role, authenticated;

-- ─── Step 3: Bootstrap helper for server startup migration ────────────────────

CREATE OR REPLACE FUNCTION public.apply_pagerank_migration_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result text := '';
BEGIN
  -- Add pagerank_score column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'pagerank_score'
  ) THEN
    ALTER TABLE memories ADD COLUMN pagerank_score float DEFAULT 0.0;
    v_result := v_result || 'added pagerank_score column; ';
  ELSE
    v_result := v_result || 'pagerank_score column exists; ';
  END IF;

  RETURN TRIM(v_result);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_pagerank_migration_if_missing() TO service_role;

-- ─── Step 4: Update hybrid_recall() to incorporate PageRank boost ─────────────
-- Final score formula: rrf_score * importance_score / decay * (1 + 0.2 * pagerank_score)
-- PageRank boost is additive to the existing adaptive decay formula.

DROP FUNCTION IF EXISTS public.hybrid_recall(text, vector, integer, double precision, text, integer);
DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, integer, double precision, text, integer);
DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text);

CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text text,
  p_query_embedding text,
  p_match_threshold float DEFAULT 0.3,
  p_match_count int DEFAULT 20,
  p_filter_type text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  type text,
  name text,
  description text,
  content text,
  tags text[],
  source text,
  conflict_flagged boolean,
  access_count integer,
  importance_score float,
  hybrid_score double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_embedding vector(768);
  result_ids uuid[];
BEGIN
  v_embedding := p_query_embedding::vector;

  -- Collect the IDs of top results first (for the UPDATE below)
  WITH
  vec_ranked AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (
        ORDER BY (m.embedding::vector) <=> v_embedding ASC
      ) AS vec_rank
    FROM memories m
    WHERE
      m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25_rank
    FROM memories m
    WHERE
      m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.id, b.id) AS mem_id,
      (
        COALESCE(1.0 / (60.0 + v.vec_rank), 0.0) +
        COALESCE(1.0 / (60.0 + b.bm25_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.id = b.id
  ),
  final AS (
    SELECT
      rrf.mem_id,
      -- PageRank-boosted adaptive decay score
      -- λ(n) = 1 / (1 + ln(1 + access_count)) — frequently accessed memories decay slower
      -- PageRank boost: multiply by (1 + 0.2 * pagerank_score) to surface well-linked memories
      (
        rrf.rrf_score
        * COALESCE(m.importance_score, 0.5)
        / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float))
        * (1.0 + 0.2 * COALESCE(m.pagerank_score, 0.0))
      )::double precision AS computed_score
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    ORDER BY computed_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(mem_id) INTO result_ids FROM final;

  -- Update access tracking for returned memories
  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories
    SET
      access_count = COALESCE(access_count, 0) + 1,
      accessed_at = now(),
      last_accessed_at = now()
    WHERE id = ANY(result_ids);
  END IF;

  -- Return results with PageRank-boosted scores
  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (
        ORDER BY (m.embedding::vector) <=> v_embedding ASC
      ) AS vec_rank
    FROM memories m
    WHERE
      m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25_rank
    FROM memories m
    WHERE
      m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.id, b.id) AS mem_id,
      (
        COALESCE(1.0 / (60.0 + v.vec_rank), 0.0) +
        COALESCE(1.0 / (60.0 + b.bm25_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.id = b.id
  )
  SELECT
    m.id,
    m.type,
    m.name,
    m.description,
    m.content,
    m.tags,
    m.source,
    m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    (
      rrf.rrf_score
      * COALESCE(m.importance_score, 0.5)
      / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float))
      * (1.0 + 0.2 * COALESCE(m.pagerank_score, 0.0))
    )::double precision AS hybrid_score
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
  ORDER BY hybrid_score DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text, text, float, int, text) TO service_role, authenticated;

-- ─── Step 5: Run initial PageRank computation ──────────────────────────────────

SELECT compute_pagerank(0.85, 20);
