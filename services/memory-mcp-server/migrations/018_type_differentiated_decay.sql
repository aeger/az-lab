-- Migration 018: Type-Differentiated Decay Half-Lives
-- Based on: Episodic Memory Missing Piece (arxiv 2502.06975), 2026 position paper
--
-- Problem: uniform 7-day recency half-life treats ephemeral project memories the same
-- as durable feedback/user/reference memories. Stale task context contaminates recall.
--
-- Solution: type-specific decay exponents in the A-MAC recency signal (weight α=0.25):
--   project type:              7-day half-life  λ = ln(2)/7  = 0.0990
--   feedback/user/reference:  30-day half-life  λ = ln(2)/30 = 0.0231
--
-- Expected gain: stale project memories (resolved incidents, old task_queue items)
-- decay out of recall naturally; durable facts (feedback, user profile, references)
-- remain discoverable across multi-week gaps between sessions.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Drop previous signature before CREATE OR REPLACE ──────────────────────────
DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text);

-- ─── hybrid_recall: type-differentiated recency decay + dual-BM25 + RRF + A-MAC ──

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
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  -- ── Pass 1: collect result IDs for access tracking UPDATE ────────────────
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
  ),
  -- A-MAC with type-differentiated recency decay (migration 018):
  --   project → 7-day half-life  (λ = ln(2)/7  = 0.0990)
  --   others  → 30-day half-life (λ = ln(2)/30 = 0.0231)
  final AS (
    SELECT rrf.mem_id,
      (
        0.25 * EXP(
          CASE WHEN m.type = 'project'
            THEN -0.0990 * GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
            ELSE -0.0231 * GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
          END
        )
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
    -- A-MAC 5-signal composite with type-differentiated recency decay
    (
      0.25 * EXP(
        CASE WHEN m.type = 'project'
          THEN -0.0990 * GREATEST(
            EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
          ELSE -0.0231 * GREATEST(
            EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
        END
      )
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

-- ─── Update prune_decayed_memories with type-differentiated recency ───────────

CREATE OR REPLACE FUNCTION public.prune_decayed_memories(
  min_age_days       int   DEFAULT 30,
  min_amac_threshold float DEFAULT 0.20
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM memories
  WHERE
    updated_at < now() - (min_age_days || ' days')::interval
    AND (
      (
        0.25 * EXP(
          CASE WHEN type = 'project'
            THEN -0.0990 * GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(last_accessed_at, created_at, updated_at))) / 86400.0, 0.0)
            ELSE -0.0231 * GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(last_accessed_at, created_at, updated_at))) / 86400.0, 0.0)
          END
        )
      + 0.20 * LEAST(LN(1.0 + COALESCE(access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(amac_novelty_score, 0.5)
      + 0.25 * COALESCE(importance_score, 0.5)
      ) / 0.85
    ) < min_amac_threshold;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prune_decayed_memories TO service_role;

-- ─── Idempotent sentinel ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_type_decay_migration_if_missing()
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

  IF func_body LIKE '%0.0990%' THEN
    RETURN 'migration 018: type-differentiated decay active (project=7d λ=0.0990, others=30d λ=0.0231)';
  ELSE
    RETURN 'WARNING: type-differentiated decay missing — re-apply 018_type_differentiated_decay.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_type_decay_migration_if_missing()
  TO service_role, authenticated;
