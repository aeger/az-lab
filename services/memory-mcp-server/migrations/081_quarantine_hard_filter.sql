-- Migration 081: hard-filter trust_tier = 'quarantined' out of hybrid_recall
-- Ref: 2026-07-28 daily research, tier 3 (close the hard-quarantine gate)
--
-- WHY NOW, AND WHY THIS IS FREE
--   Migration 061 wired trust_tier into recall as a SOFT down-weight only:
--   trust_weight() maps quarantined -> 0.40, which demotes a poisoned memory but
--   still lets it surface. The rationale for stopping at a down-weight was that
--   259 rows (~34% of the corpus) were trust_tier 'unknown', and a hard filter
--   would have silently deleted a third of recall.
--
--   That rationale is now void. Verified 2026-07-28 against Supabase:
--     trust_tier: 540 high / 304 medium / 17 low / 0 unknown / 0 quarantined
--   Every row is tiered. Migration 076 shipped quarantined-injection-detection
--   and has quarantined nothing.
--
--   So this filter is a no-op ON TODAY'S DATA — by construction it must produce
--   EXACTLY zero retrieval delta at 0 quarantined rows, which is the whole point
--   of landing it now. The alternative is landing it during the first real
--   prompt-injection event, under time pressure, with no way to tell a filter bug
--   apart from the incident it was written to contain.
--
-- THE TWO-SITE HAZARD (this is the part that breaks if you get it wrong)
--   hybrid_recall scores memories TWICE against two independent copies of the
--   6-lane RRF + A-MAC pipeline:
--     1. the `ranked` CTE, whose ids are collected INTO result_ids  (selection)
--     2. the RETURN QUERY at the bottom, filtered to `id = ANY(result_ids)` (output)
--   trust_weight() is applied at both. A filter added to only ONE site makes
--   selection and output disagree: filtering only (1) leaves the output ordering
--   computed over an unfiltered score set, and filtering only (2) silently returns
--   fewer than p_match_count rows. Both sites get the predicate. Site (2) is
--   strictly redundant while (1) holds — it is defence in depth, so a future edit
--   that reworks the selection CTE cannot leak a quarantined row to a caller.
--
-- SEMANTICS
--   IS DISTINCT FROM (not <>) so a NULL trust_tier is KEPT, not silently dropped.
--   A row with no tier yet is untriaged, not untrusted — dropping NULLs here would
--   make every not-yet-triaged new memory invisible to recall, which is the exact
--   34%-of-corpus failure the soft-only decision was avoiding.
--
--   Everything else in this function is byte-identical to the pre-081 definition.
--   Verified by md5: stripping the two added predicates from the deployed body
--   reproduces md5 cfeb0e197286318ec6aea16e36a8ea2c (the 080-era definition).

CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text text,
  p_query_embedding text DEFAULT NULL::text,
  p_match_threshold double precision DEFAULT 0.3,
  p_match_count integer DEFAULT 20,
  p_filter_type text DEFAULT NULL::text,
  p_agent_id text DEFAULT NULL::text,
  p_agent_scope text DEFAULT NULL::text,
  p_min_confidence double precision DEFAULT 0.0,
  p_memory_class text DEFAULT NULL::text,
  p_topic_hint text DEFAULT NULL::text,
  p_query_entities text[] DEFAULT NULL::text[]
)
RETURNS TABLE(
  id uuid, type text, name text, description text, content text, tags text[],
  source text, conflict_flagged boolean, access_count integer,
  importance_score double precision, hybrid_score double precision,
  confidence double precision, staleness_candidate boolean, memory_class text,
  matched_entities text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
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
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
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
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND m.is_active IS NOT FALSE
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
      (  COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank), 0.0)
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
          GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
          / CASE m.memory_class WHEN 'semantic' THEN 60.0 WHEN 'episodic' THEN 7.0 WHEN 'procedural' THEN 180.0 ELSE 10.0 END,
          CASE m.memory_class WHEN 'semantic' THEN 0.70 WHEN 'episodic' THEN 1.30 WHEN 'procedural' THEN 0.50 ELSE 1.00 END
        ))
      + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
      + 0.25 * COALESCE(m.importance_score, 0.5)
      + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
      + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
      )::float * public.trust_weight(m.trust_tier) * public.governance_weight(m.superseded_by, m.conflict_flagged) AS hybrid_score,
      COALESCE(m.confidence, 0.8)::float AS confidence,
      COALESCE(m.staleness_candidate, false) AS staleness_candidate,
      m.memory_class,
      CASE WHEN v_entities IS NOT NULL THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities)) ELSE ARRAY[]::text[] END AS matched_entities
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND m.trust_tier IS DISTINCT FROM 'quarantined'
    ORDER BY hybrid_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(ranked.id) INTO result_ids FROM ranked;

  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count = COALESCE(mem_upd.access_count, 0) + 1,
        recall_count = COALESCE(mem_upd.recall_count, 0) + 1,
        accessed_at = now(), last_accessed_at = now(), last_accessed = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
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
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
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
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND m.is_active IS NOT FALSE
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
      (  COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank), 0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank), 0.0)
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
        GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0, 0.0)
        / CASE m.memory_class WHEN 'semantic' THEN 60.0 WHEN 'episodic' THEN 7.0 WHEN 'procedural' THEN 180.0 ELSE 10.0 END,
        CASE m.memory_class WHEN 'semantic' THEN 0.70 WHEN 'episodic' THEN 1.30 WHEN 'procedural' THEN 0.50 ELSE 1.00 END
      ))
    + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
    + 0.25 * COALESCE(m.importance_score, 0.5)
    + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
    + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
    )::float * public.trust_weight(m.trust_tier) * public.governance_weight(m.superseded_by, m.conflict_flagged) AS hybrid_score,
    COALESCE(m.confidence, 0.8)::float,
    COALESCE(m.staleness_candidate, false),
    m.memory_class,
    CASE WHEN v_entities IS NOT NULL THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities)) ELSE ARRAY[]::text[] END AS matched_entities
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE m.is_active IS NOT FALSE AND m.id = ANY(result_ids)
    AND m.trust_tier IS DISTINCT FROM 'quarantined'
  ORDER BY hybrid_score DESC;
END;
$function$;
