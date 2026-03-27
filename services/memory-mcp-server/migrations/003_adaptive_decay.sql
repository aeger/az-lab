-- Migration 003: Adaptive Decay with Access-Frequency Modulation
-- FadeMem/ACT-R pattern: frequently-accessed memories decay slower
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Add new columns ──────────────────────────────────────────────────

ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance_score float DEFAULT 0.5;

-- Back-fill last_accessed_at from existing accessed_at (they track the same thing)
UPDATE memories SET last_accessed_at = accessed_at WHERE last_accessed_at IS NULL AND accessed_at IS NOT NULL;

-- ─── Step 2: Bootstrap helper function for server startup migration ───────────

CREATE OR REPLACE FUNCTION public.apply_adaptive_decay_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result text := '';
BEGIN
  -- Add last_accessed_at column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'last_accessed_at'
  ) THEN
    ALTER TABLE memories ADD COLUMN last_accessed_at timestamptz;
    UPDATE memories SET last_accessed_at = accessed_at WHERE last_accessed_at IS NULL AND accessed_at IS NOT NULL;
    v_result := v_result || 'added last_accessed_at; ';
  ELSE
    v_result := v_result || 'last_accessed_at exists; ';
  END IF;

  -- Add importance_score column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'importance_score'
  ) THEN
    ALTER TABLE memories ADD COLUMN importance_score float DEFAULT 0.5;
    v_result := v_result || 'added importance_score; ';
  ELSE
    v_result := v_result || 'importance_score exists; ';
  END IF;

  RETURN TRIM(v_result);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_adaptive_decay_if_missing() TO service_role;

-- ─── Step 3: Update touch_memory to also update last_accessed_at ─────────────

CREATE OR REPLACE FUNCTION public.touch_memory(memory_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE memories
  SET
    access_count = COALESCE(access_count, 0) + 1,
    accessed_at = now(),
    last_accessed_at = now()
  WHERE id = memory_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.touch_memory(uuid) TO service_role, authenticated;

-- ─── Step 4: Rewrite hybrid_recall with adaptive decay ────────────────────────
-- λ(n) = base_decay / (1 + ln(1 + access_count))
-- Higher access_count → denominator grows → decay rate λ shrinks
-- → frequently-accessed memories retain higher scores longer
--
-- The function also:
-- a) Includes importance_score in results
-- b) Fixes the prior "column 10 real vs double precision" type mismatch
-- c) Updates access_count and last_accessed_at for returned memories

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
      -- Adaptive decay: λ(n) = 1 / (1 + ln(1 + access_count))
      -- Multiply RRF score by importance_score for importance-weighted retrieval
      (
        rrf.rrf_score
        * COALESCE(m.importance_score, 0.5)
        / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float))
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

  -- Return results with adaptive decay scores
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
    )::double precision AS hybrid_score
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
  ORDER BY hybrid_score DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall TO service_role, authenticated;

-- ─── Step 5: Nightly decay cleanup function ───────────────────────────────────
-- Removes memories that have fully decayed AND were never accessed AND are old.
-- Called by the nightly cron job on svc-podman-01.

CREATE OR REPLACE FUNCTION public.prune_decayed_memories(
  min_age_days int DEFAULT 30,
  max_access_count int DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- Delete memories that:
  -- 1. Have never been accessed (access_count = 0)
  -- 2. Haven't been updated in min_age_days
  -- 3. Low importance score (< 0.3 or null with default)
  -- This is conservative: we only delete truly untouched, old, low-importance memories
  DELETE FROM memories
  WHERE
    COALESCE(access_count, 0) <= max_access_count
    AND last_accessed_at < now() - (min_age_days || ' days')::interval
    AND COALESCE(importance_score, 0.5) < 0.3
    AND updated_at < now() - (min_age_days || ' days')::interval;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prune_decayed_memories TO service_role;

-- ─── Step 6: pg_cron setup (if available) ─────────────────────────────────────
-- Attempt to schedule nightly cleanup at 2am UTC.
-- This block will silently fail if pg_cron is not enabled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'prune-decayed-memories',
      '0 2 * * *',
      $$SELECT prune_decayed_memories(30, 0)$$
    );
    RAISE NOTICE 'pg_cron job scheduled: prune-decayed-memories at 2am UTC daily';
  ELSE
    RAISE NOTICE 'pg_cron not available — cron job will be managed by systemd on svc-podman-01';
  END IF;
END $$;
