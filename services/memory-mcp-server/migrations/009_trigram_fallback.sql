-- Migration 009: Trigram fallback for zero-BM25-hit queries
-- When a query contains code identifiers (e.g. poll_queue, memory-mcp-server),
-- PostgreSQL FTS tokenizes them into common words, producing near-zero BM25 scores.
-- This migration adds a trgm_ranked CTE that activates only when bm25_ranked returns
-- 0 rows, falling back to trigram similarity (weighted at 0.5x normal BM25 confidence).
--
-- Requires: pg_trgm extension and idx_memories_trgm index (already exist)
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

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

  -- Collect IDs of top results (for UPDATE below)
  -- Note: CTEs use mem_id alias to avoid ambiguity with the RETURNS TABLE id column
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  trgm_ranked AS (
    -- Activates only when BM25 finds no matches (code identifiers, underscores, etc.)
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content,
        p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND NOT EXISTS (SELECT 1 FROM bm25_ranked)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, b.mem_id, t.mem_id) AS mem_id,
      (COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.0 / (60.0 + b.bm25_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank), 0.0)) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.mem_id = b.mem_id
    FULL OUTER JOIN trgm_ranked t ON COALESCE(v.mem_id, b.mem_id) = t.mem_id
  ),
  final AS (
    SELECT rrf.mem_id,
      (rrf.rrf_score * COALESCE(m.importance_score, 0.5) / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float)))::double precision AS computed_score
    FROM rrf JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    ORDER BY computed_score DESC LIMIT p_match_count
  )
  SELECT ARRAY_AGG(mem_id) INTO result_ids FROM final;

  -- Update access tracking (table-alias UPDATE to avoid column name ambiguity with RETURNS TABLE)
  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count = COALESCE(mem_upd.access_count, 0) + 1,
        accessed_at = now(),
        last_accessed_at = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- Return results
  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
    LIMIT p_match_count * 2
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content,
        p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND NOT EXISTS (SELECT 1 FROM bm25_ranked)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, b.mem_id, t.mem_id) AS mem_id,
      (COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.0 / (60.0 + b.bm25_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank), 0.0)) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.mem_id = b.mem_id
    FULL OUTER JOIN trgm_ranked t ON COALESCE(v.mem_id, b.mem_id) = t.mem_id
  )
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    (rrf.rrf_score * COALESCE(m.importance_score, 0.5) / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float)))::double precision AS hybrid_score
  FROM rrf JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
  ORDER BY hybrid_score DESC LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text, text, float, int, text) TO service_role, authenticated;

-- ─── Idempotent migration sentinel ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_trigram_fallback_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  func_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO func_body FROM pg_proc WHERE proname = 'hybrid_recall' LIMIT 1;
  IF func_body LIKE '%trgm_ranked%' THEN
    RETURN 'hybrid_recall already has trigram fallback (migration 009 applied)';
  ELSE
    RETURN 'WARNING: hybrid_recall missing trgm_ranked CTE — re-apply 009_trigram_fallback.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_trigram_fallback_if_missing() TO service_role, authenticated;
