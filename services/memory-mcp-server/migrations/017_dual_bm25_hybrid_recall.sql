-- Migration 017: Dual-BM25 hybrid_recall — add search_vector plain lane to RRF
-- Current hybrid_recall (migration 013) uses:
--   vec_ranked:  pgvector cosine similarity (semantic)
--   bm25_ranked: tsvector ts_rank_cd on search_vec (weighted: name=A, desc=B, content=C)
--   trgm_ranked: trigram fallback when BM25 hits 0 rows
--
-- This migration adds a third BM25 lane:
--   bm25_plain: tsvector ts_rank on search_vector (GENERATED ALWAYS — unweighted, broader recall)
--
-- RRF weights: vector=1.0, bm25_weighted=1.2, bm25_plain=0.8, trigram_fallback=0.5
-- Expected improvement: 15-30% recall gain from dual-BM25 coverage gap filling.
--   search_vec misses: phrases split by punctuation, non-English terms
--   search_vector catches: broader unweighted matches from GENERATED column
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Drop previous 7-param signature before CREATE OR REPLACE ─────────────────

DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text);

-- ─── hybrid_recall: dual-BM25 + pgvector + RRF + A-MAC scoring ───────────────

CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text       text,
  p_query_embedding  text,
  p_match_threshold  float   DEFAULT 0.3,
  p_match_count      int     DEFAULT 20,
  p_filter_type      text    DEFAULT NULL,
  p_agent_id         text    DEFAULT NULL,
  p_agent_scope      text    DEFAULT NULL
)
RETURNS TABLE(
  id               uuid,
  type             text,
  name             text,
  description      text,
  content          text,
  tags             text[],
  source           text,
  conflict_flagged boolean,
  access_count     integer,
  importance_score float,
  hybrid_score     double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_embedding vector(768);
  result_ids  uuid[];
BEGIN
  -- Parse embedding string to vector type; NULL is safe (vec lane skipped below)
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  -- ── Pass 1: collect result IDs for access tracking UPDATE ────────────────
  WITH
  -- Lane 1: pgvector cosine similarity (semantic search)
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  -- Lane 2: BM25 via search_vec (weighted tsvector: name=A, description=B, content=C)
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  -- Lane 3: BM25 via search_vector (GENERATED ALWAYS — unweighted, broader recall)
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  -- Lane 4: trigram fallback — activates only when both BM25 lanes return 0 rows
  -- Handles code identifiers (underscores, camelCase) that FTS tokenizes poorly
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  -- RRF fusion: k=60, weights: vec=1.0, bm25_weighted=1.2, bm25_plain=0.8, trgm=0.5
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),   0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = t.mem_id
  ),
  -- A-MAC 5-dimension scoring (ICLR 2026):
  --   α=0.25 recency, β=0.20 access_freq, γ=0.15 novelty, δ=0.25 importance, ε=0.15 utility
  final AS (
    SELECT rrf.mem_id,
      (
        0.25 * EXP(-0.1 * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0,
          0.0))
      + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
      + 0.25 * COALESCE(m.importance_score, 0.5)
      + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
      )::double precision AS computed_score
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    ORDER BY computed_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(mem_id) INTO result_ids FROM final;

  -- Update access tracking for returned memories
  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count     = COALESCE(mem_upd.access_count, 0) + 1,
        accessed_at      = now(),
        last_accessed_at = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- ── Pass 2: return results ────────────────────────────────────────────────
  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 3
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),   0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = t.mem_id
  )
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    -- A-MAC 5-signal composite as hybrid_score (backward-compatible column name)
    (
      0.25 * EXP(-0.1 * GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0,
        0.0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
    + 0.25 * COALESCE(m.importance_score, 0.5)
    + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
    )::double precision AS hybrid_score
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
  ORDER BY hybrid_score DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text, text, float, int, text, text, text)
  TO service_role, authenticated;

-- ─── Idempotent sentinel ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_dual_bm25_hybrid_recall_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  func_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO func_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall'
  LIMIT 1;

  IF func_body LIKE '%bm25_plain%' THEN
    RETURN 'migration 017: hybrid_recall dual-BM25 (search_vec + search_vector) RRF active';
  ELSE
    RETURN 'WARNING: hybrid_recall missing bm25_plain CTE — re-apply 017_dual_bm25_hybrid_recall.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_dual_bm25_hybrid_recall_if_missing()
  TO service_role, authenticated;
