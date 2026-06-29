-- Migration 044: extend Weibull decay (043) to the entity_linking hybrid_recall
-- overload and remove obsolete pre-topic-hint overloads.
--
-- Why: there are four public.hybrid_recall overloads (8/9/10/11 args). Migration
-- 043 upgraded the 10-arg topic-hint variant. Migration 039's 11-arg entity-aware
-- variant is the actual function PostgREST often dispatches to (it auto-extracts
-- entities when p_query_entities is NULL, so even runtime callers that don't
-- pass entities can land here). That overload still had the old fixed-rate
-- exponential decay  EXP(-0.1 * age_days). Patching it here keeps decay
-- consistent across whichever overload Postgres picks.
--
-- Also drops the obsolete 8-arg and 9-arg overloads (predate p_topic_hint and
-- p_query_entities and are no longer reachable from src/index.ts) — this
-- eliminates the dispatch ambiguity that surfaced when calling hybrid_recall
-- with fewer than the full named-arg set.

DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text, float);
DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text, float, text);

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
  p_topic_hint      text    DEFAULT NULL,
  p_query_entities  text[]  DEFAULT NULL
)
RETURNS TABLE(
  id                  uuid,
  type                text,
  name                text,
  description         text,
  content             text,
  tags                text[],
  source              text,
  conflict_flagged    boolean,
  access_count        integer,
  importance_score    float,
  hybrid_score        float,
  confidence          float,
  staleness_candidate boolean,
  memory_class        text,
  matched_entities    text[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_embedding vector(768);
  result_ids  uuid[];
  v_topic     text := NULLIF(TRIM(COALESCE(p_topic_hint, '')), '');
  v_entities  text[];
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  v_entities := COALESCE(p_query_entities, public.extract_entities(p_query_text));
  IF v_entities IS NOT NULL AND array_length(v_entities, 1) IS NULL THEN
    v_entities := NULL;
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
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC
      ) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL
      AND m.entities && v_entities
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
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),     0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank),  0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank),  0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank),  0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank),  0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),    0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  ranked AS (
    SELECT m.id, m.type, m.name, m.description, m.content, m.tags, m.source,
      m.conflict_flagged,
      COALESCE(m.access_count, 0)::integer AS access_count,
      COALESCE(m.importance_score, 0.5)::float AS importance_score,
      (
        0.25 * EXP(- POWER(
          GREATEST(
            EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
            0.0
          ) / CASE m.memory_class
                WHEN 'semantic'   THEN 60.0
                WHEN 'episodic'   THEN 7.0
                WHEN 'procedural' THEN 180.0
                ELSE 10.0
              END,
          CASE m.memory_class
            WHEN 'semantic'   THEN 0.70
            WHEN 'episodic'   THEN 1.30
            WHEN 'procedural' THEN 0.50
            ELSE 1.00
          END
        ))
      + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
      + 0.25 * COALESCE(m.importance_score, 0.5)
      + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
      + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
      )::float AS hybrid_score,
      COALESCE(m.confidence, 0.8)::float AS confidence,
      COALESCE(m.staleness_candidate, false) AS staleness_candidate,
      m.memory_class,
      CASE
        WHEN v_entities IS NOT NULL
        THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))
        ELSE ARRAY[]::text[]
      END AS matched_entities
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY hybrid_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(ranked.id) INTO result_ids FROM ranked;

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
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC
      ) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL
      AND m.entities && v_entities
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
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),     0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank),  0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank),  0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank),  0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank),  0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),    0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  )
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    (
      0.25 * EXP(- POWER(
        GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
          0.0
        ) / CASE m.memory_class
              WHEN 'semantic'   THEN 60.0
              WHEN 'episodic'   THEN 7.0
              WHEN 'procedural' THEN 180.0
              ELSE 10.0
            END,
        CASE m.memory_class
          WHEN 'semantic'   THEN 0.70
          WHEN 'episodic'   THEN 1.30
          WHEN 'procedural' THEN 0.50
          ELSE 1.00
        END
      ))
    + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
    + 0.25 * COALESCE(m.importance_score, 0.5)
    + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
    + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
    )::float AS hybrid_score,
    COALESCE(m.confidence, 0.8)::float,
    COALESCE(m.staleness_candidate, false),
    m.memory_class,
    CASE
      WHEN v_entities IS NOT NULL
      THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))
      ELSE ARRAY[]::text[]
    END AS matched_entities
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE m.id = ANY(result_ids)
  ORDER BY hybrid_score DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text,text,float,int,text,text,text,float,text,text,text[]) TO service_role;

-- Sentinel for startup readiness check
CREATE OR REPLACE FUNCTION public.apply_weibull_decay_entity_if_missing()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname  = 'hybrid_recall'
    AND 'p_query_entities' = ANY(p.proargnames)
  LIMIT 1;

  IF v_src IS NULL THEN
    RETURN 'hybrid_recall(entity variant) not found - run migration 039 first';
  END IF;
  IF v_src NOT LIKE '%POWER(%memory_class%' THEN
    RETURN 'weibull decay missing on entity overload - run migration 044';
  END IF;
  RETURN 'weibull decay present on entity overload';
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_weibull_decay_entity_if_missing() TO service_role;
