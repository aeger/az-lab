-- Migration 013: A-MAC 5-Dimension Memory Decay Scoring (ICLR 2026)
-- Replaces single-scalar ACT-R decay with A-MAC composite:
--   C(m,q) = α*recency + β*access_freq + γ*novelty + δ*importance_llm + ε*utility
-- Weights: α=0.25 recency, β=0.20 access_freq, γ=0.15 novelty, δ=0.25 importance, ε=0.15 utility
-- Expected: F1=0.583 (+7.8% over A-Mem baseline), recall=0.972
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Add amac_novelty_score column ───────────────────────────────────
-- Semantic novelty: pre-computed score measuring how unique/isolated this memory is.
-- High pagerank (well-linked) → low novelty; isolated memories → high novelty.
-- Background jobs can update this as the link graph evolves.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS amac_novelty_score float DEFAULT 0.5;

-- Initialize from existing pagerank_score: 1 / (1 + pagerank * 20)
-- Memories with no links (pagerank ≈ 0) get novelty ≈ 1.0
-- Highly-connected memories (pagerank ≈ 0.05) get novelty ≈ 0.5
UPDATE memories
SET amac_novelty_score = ROUND(
  LEAST(1.0 / (1.0 + COALESCE(pagerank_score, 0.0) * 20.0), 1.0)::numeric, 4
)::float
WHERE amac_novelty_score IS NULL OR amac_novelty_score = 0.5;

CREATE INDEX IF NOT EXISTS idx_memories_amac_novelty ON memories(amac_novelty_score);

-- ─── Step 2: Idempotent sentinel (called by applyStartupMigrations) ──────────

CREATE OR REPLACE FUNCTION public.apply_amac_scoring_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'amac_novelty_score'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 013: amac_novelty_score present — A-MAC 5D scoring active (α=0.25 recency, β=0.20 freq, γ=0.15 novelty, δ=0.25 importance, ε=0.15 utility)';
  ELSE
    RETURN 'WARNING: amac_novelty_score missing — re-apply 013_amac_scoring.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_amac_scoring_if_missing() TO service_role, authenticated;

-- ─── Step 3: Replace hybrid_recall with A-MAC composite scoring ──────────────
-- Signal definitions:
--   recency     = EXP(-0.1 * days_since_last_access)          half-life ≈ 7 days
--   access_freq = LEAST(LN(1 + access_count) / LN(101), 1.0)  log-normalized, cap at 100
--   novelty     = amac_novelty_score                           pre-computed (updated by bg job)
--   importance  = importance_score                             LLM-assigned, 0–1
--   utility     = LEAST(rrf_score / 0.033, 1.0)               RRF relevance normalized to [0,1]
--
-- All signals are in [0,1]. Weights sum to 1.0.
-- hybrid_score column name preserved for backward compatibility with TypeScript callers.

DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text);

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
  v_embedding := p_query_embedding::vector;

  -- ── Pass 1: collect result IDs so we can UPDATE access tracking ─────────
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 2
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
      AND NOT EXISTS (SELECT 1 FROM bm25_ranked)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, b.mem_id, t.mem_id) AS mem_id,
      (COALESCE(1.0 / (60.0 + v.vec_rank),   0.0)
     + COALESCE(1.0 / (60.0 + b.bm25_rank),  0.0)
     + COALESCE(0.5 / (60.0 + t.trgm_rank),  0.0)) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.mem_id = b.mem_id
    FULL OUTER JOIN trgm_ranked t ON COALESCE(v.mem_id, b.mem_id) = t.mem_id
  ),
  final AS (
    SELECT rrf.mem_id,
      -- A-MAC composite (α=0.25, β=0.20, γ=0.15, δ=0.25, ε=0.15)
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
    SET access_count    = COALESCE(mem_upd.access_count, 0) + 1,
        accessed_at     = now(),
        last_accessed_at = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- ── Pass 2: return results with A-MAC composite as hybrid_score ──────────
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
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 2
  ),
  bm25_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25_rank
    FROM memories m
    WHERE m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
    LIMIT p_match_count * 2
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
      AND NOT EXISTS (SELECT 1 FROM bm25_ranked)
    LIMIT p_match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, b.mem_id, t.mem_id) AS mem_id,
      (COALESCE(1.0 / (60.0 + v.vec_rank),   0.0)
     + COALESCE(1.0 / (60.0 + b.bm25_rank),  0.0)
     + COALESCE(0.5 / (60.0 + t.trgm_rank),  0.0)) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_ranked b ON v.mem_id = b.mem_id
    FULL OUTER JOIN trgm_ranked t ON COALESCE(v.mem_id, b.mem_id) = t.mem_id
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

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text, text, float, int, text, text, text) TO service_role, authenticated;

-- ─── Step 4: Update prune_decayed_memories to use A-MAC composite ─────────────
-- Old threshold: importance_score < 0.3 AND access_count = 0 AND 30+ days old
-- New: A-MAC composite (without utility — no query context) < min_amac_threshold
-- C_prune(m) = (0.25*recency + 0.20*access_freq + 0.15*novelty + 0.25*importance) / 0.85
-- Threshold of 0.20 ≈ a 30-day-old, never-accessed, low-importance (0.3) memory.

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
    -- Conservative age gate: only consider memories older than min_age_days
    updated_at < now() - (min_age_days || ' days')::interval
    -- A-MAC composite (no utility signal, weights re-normalized to sum=1 by /0.85)
    AND (
      (
        0.25 * EXP(-0.1 * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(last_accessed_at, created_at, updated_at))) / 86400.0,
          0.0))
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
