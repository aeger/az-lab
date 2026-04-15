-- Migration 010: agent_id + visibility for multi-agent memory isolation
-- Adds per-agent ownership and shared/private visibility to memories.
-- Private memories (visibility='private') are only visible to the owning agent.
-- Shared memories (visibility='shared', default) are visible to all agents.
-- agent_id values: wren, iris, atlas, forge, volt (matches az-lab agent roster)
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Add columns ──────────────────────────────────────────────────────

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS agent_id text,
  ADD COLUMN IF NOT EXISTS visibility text DEFAULT 'shared';

-- ─── Step 2: Indexes ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility);

-- ─── Step 3: Update hybrid_recall to filter by visibility/agent_id ────────────
-- Adds optional p_agent_id parameter. When set, returns:
--   visibility='shared' OR (visibility='private' AND agent_id = p_agent_id)
-- When p_agent_id is NULL (legacy callers), returns all memories (backward compat).

DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text);

CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text text,
  p_query_embedding text,
  p_match_threshold float DEFAULT 0.3,
  p_match_count int DEFAULT 20,
  p_filter_type text DEFAULT NULL,
  p_agent_id text DEFAULT NULL
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

  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
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
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
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
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    ORDER BY computed_score DESC LIMIT p_match_count
  )
  SELECT ARRAY_AGG(mem_id) INTO result_ids FROM final;

  -- Update access tracking
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
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
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
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
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
    AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
  ORDER BY hybrid_score DESC LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text, text, float, int, text, text) TO service_role, authenticated;

-- ─── Step 4: Idempotent sentinel ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_agent_visibility_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'agent_id'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 010: agent_id + visibility columns already present';
  ELSE
    RETURN 'WARNING: agent_id column missing — re-apply 010_agent_visibility.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_agent_visibility_if_missing() TO service_role, authenticated;
