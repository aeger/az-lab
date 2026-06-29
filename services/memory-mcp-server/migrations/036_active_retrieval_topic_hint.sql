-- Migration 036: Active Retrieval — topic_hint parameter for hybrid_recall
--
-- Implements MIRIX-paper "Active Retrieval" (arxiv.org/abs/2507.07957, 85.4% LOCOMO):
-- agents generate a 3-5 word topic before recall, which is fed alongside the verbose
-- query as a high-precision signal. The topic acts as a 5th RRF lane with a weight
-- of 1.5 (higher than weighted-BM25's 1.2) — when the agent's distilled intent
-- matches a memory's name/description/content, that memory gets pulled higher
-- regardless of how much off-topic chatter the surrounding query contains.
--
-- Backwards compatible: p_topic_hint defaults to NULL; behaviour identical to
-- migration 028 + 030 when no hint is supplied. Existing 9-arg callers keep working.

CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text      text,
  p_query_embedding text    DEFAULT NULL,
  p_match_threshold float   DEFAULT 0.3,
  p_match_count     int     DEFAULT 20,
  p_filter_type     text    DEFAULT NULL,
  p_agent_id        text    DEFAULT NULL,
  p_agent_scope     text    DEFAULT NULL,
  p_min_confidence  float   DEFAULT 0.0,
  p_memory_class    text    DEFAULT NULL,
  p_topic_hint      text    DEFAULT NULL
)
RETURNS TABLE(
  id                uuid,
  type              text,
  name              text,
  description       text,
  content           text,
  tags              text[],
  source            text,
  conflict_flagged  boolean,
  access_count      integer,
  importance_score  float,
  hybrid_score      float,
  confidence        float,
  staleness_candidate boolean,
  memory_class      text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_embedding vector(768);
  result_ids  uuid[];
  v_topic     text := NULLIF(TRIM(COALESCE(p_topic_hint, '')), '');
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL
      AND m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),   0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = t.mem_id
  ),
  final AS (
    SELECT rrf.mem_id,
      (
        0.25 * EXP(-0.1 * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
          0.0))
      + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
      + 0.25 * COALESCE(m.importance_score, 0.5)
      + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
      + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
      )::double precision AS computed_score
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY computed_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(mem_id) INTO result_ids FROM final;

  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count     = COALESCE(mem_upd.access_count, 0) + 1,
        recall_count     = COALESCE(mem_upd.recall_count, 0) + 1,
        accessed_at      = now(),
        last_accessed_at = now(),
        last_accessed    = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL
      AND m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
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
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),   0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = t.mem_id
  )
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    (
      0.25 * EXP(-0.1 * GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
        0.0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
    + 0.25 * COALESCE(m.importance_score, 0.5)
    + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
    + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
    )::double precision AS hybrid_score,
    COALESCE(m.confidence, 0.8)::double precision AS confidence,
    COALESCE(m.staleness_candidate, false)::boolean AS staleness_candidate,
    m.memory_class
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
    AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
  ORDER BY hybrid_score DESC
  LIMIT p_match_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text,text,float,int,text,text,text,float,text,text) TO service_role;

-- Sentinel for startup readiness check (mirrors prior migrations' pattern)
CREATE OR REPLACE FUNCTION public.apply_topic_hint_if_missing()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'hybrid_recall'
      AND 'p_topic_hint' = ANY(p.proargnames)
  ) THEN
    RETURN 'topic_hint not yet present — run migration 036';
  END IF;
  RETURN 'topic_hint present';
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_topic_hint_if_missing() TO service_role;
