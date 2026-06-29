-- Migration 048: Temporal supersession + writer-agent provenance
-- Source: 2026-06-26 daily research, REC P2 (Governed Shared Memory, arXiv 2606.24535)
--
-- Replaces the destructive mem0 DELETE path with a non-destructive supersession link.
-- Old rows stay in the table for audit/lineage; recall filters them out via is_active.
-- Adds writer_agent so the 4-agent fleet (Wren/Iris/Atlas/Volt) can be traced per row
-- without parsing the free-text `source` field.

-- 1. New columns ─────────────────────────────────────────────────────────────
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_active     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS writer_agent  text;

COMMENT ON COLUMN public.memories.superseded_by IS
  'If set, this row was superseded by the referenced row. Both rows stay in the table; recall filters on is_active.';
COMMENT ON COLUMN public.memories.is_active IS
  'False = superseded/retired. hybrid_recall and list_memories return only is_active=true rows.';
COMMENT ON COLUMN public.memories.writer_agent IS
  'Agent identity that last wrote this row (wren, iris, atlas, volt, hermes, lumen). Distinct from `source` which is the surface (claude-code, claude-ai, manual).';

-- 2. Index for the is_active filter (partial; most rows stay active) ─────────
CREATE INDEX IF NOT EXISTS memories_is_active_idx
  ON public.memories (is_active) WHERE is_active = false;

CREATE INDEX IF NOT EXISTS memories_superseded_by_idx
  ON public.memories (superseded_by) WHERE superseded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_writer_agent_idx
  ON public.memories (writer_agent) WHERE writer_agent IS NOT NULL;

-- 3. supersede_memory() helper ───────────────────────────────────────────────
-- Marks p_old_id superseded by p_new_id and flips is_active=false.
-- Also rewrites memory_links pointing to the old row so the graph reflects
-- the current head (links are de-duped via ON CONFLICT).
CREATE OR REPLACE FUNCTION public.supersede_memory(
  p_old_id uuid,
  p_new_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS TABLE(old_id uuid, new_id uuid, rewired_links integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rewired int := 0;
BEGIN
  IF p_old_id IS NULL OR p_new_id IS NULL THEN
    RAISE EXCEPTION 'supersede_memory: both p_old_id and p_new_id required';
  END IF;
  IF p_old_id = p_new_id THEN
    RAISE EXCEPTION 'supersede_memory: cannot supersede a memory with itself';
  END IF;

  -- Refuse if either row is missing.
  PERFORM 1 FROM memories WHERE id = p_old_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: old memory % not found', p_old_id; END IF;
  PERFORM 1 FROM memories WHERE id = p_new_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: new memory % not found', p_new_id; END IF;

  -- Flip the old row. Keep the row + content for audit/lineage walks.
  UPDATE memories
     SET superseded_by = p_new_id,
         is_active     = false,
         updated_at    = now()
   WHERE id = p_old_id;

  -- Rewire inbound links: anything pointing at old now also points at new.
  -- Skip self-loops and rows that already link to the new id.
  WITH inbound AS (
    SELECT source_id, relationship, COALESCE(link_type, 'semantic') AS link_type, COALESCE(strength, 0.5) AS strength
    FROM memory_links
    WHERE target_id = p_old_id AND source_id <> p_new_id
  )
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  SELECT source_id, p_new_id, relationship, link_type, strength FROM inbound
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
  GET DIAGNOSTICS v_rewired = ROW_COUNT;

  -- Record an explicit supersedes link old -> new so lineage walks are cheap.
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  VALUES (p_old_id, p_new_id, 'supersedes', 'temporal', 1.0)
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;

  -- Optional audit trail in memory_log if the table accepts it.
  BEGIN
    INSERT INTO memory_log (memory_id, action, details)
    VALUES (p_old_id, 'supersede', jsonb_build_object('superseded_by', p_new_id, 'reason', p_reason));
  EXCEPTION WHEN OTHERS THEN
    -- memory_log schema may differ across deployments; do not fail the supersession.
    NULL;
  END;

  RETURN QUERY SELECT p_old_id, p_new_id, v_rewired;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.supersede_memory(uuid, uuid, text)
  TO authenticated, anon, service_role;

COMMENT ON FUNCTION public.supersede_memory(uuid, uuid, text) IS
  'Non-destructive supersession. Marks old row is_active=false, sets superseded_by, rewires inbound memory_links to the new row, and writes a temporal supersedes link. Replaces mem0 DELETE for fact updates. Migration 048, 2026-06-26.';

-- 4. Patch hybrid_recall to exclude superseded rows ──────────────────────────
-- We add `AND m.is_active IS NOT FALSE` to every candidate-lane filter so
-- retired rows never make it into the RRF pool. NULL is treated as true to
-- stay backward-compatible with rows that pre-date this migration in any
-- environment that has not yet backfilled the column default.
CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text       text,
  p_query_embedding  text             DEFAULT NULL,
  p_match_threshold  double precision DEFAULT 0.3,
  p_match_count      integer          DEFAULT 20,
  p_filter_type      text             DEFAULT NULL,
  p_agent_id         text             DEFAULT NULL,
  p_agent_scope      text             DEFAULT NULL,
  p_min_confidence   double precision DEFAULT 0.0,
  p_memory_class     text             DEFAULT NULL,
  p_topic_hint       text             DEFAULT NULL,
  p_query_entities   text[]           DEFAULT NULL
)
RETURNS TABLE(
  id uuid, type text, name text, description text, content text, tags text[], source text,
  conflict_flagged boolean, access_count integer, importance_score double precision,
  hybrid_score double precision, confidence double precision, staleness_candidate boolean,
  memory_class text, matched_entities text[]
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
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
    WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
      AND m.is_active IS NOT FALSE
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
  WHERE m.is_active IS NOT FALSE
    AND m.id = ANY(result_ids)
  ORDER BY hybrid_score DESC;
END;
$function$;

COMMENT ON FUNCTION public.hybrid_recall(text, text, double precision, integer, text, text, text, double precision, text, text, text[]) IS
  'RRF hybrid retrieval over 6 lanes (vec + bm25_weighted + bm25_plain + topic + entity + trgm) with A-MAC composite scoring. Migration 048 added is_active=true filter so superseded rows are excluded.';
