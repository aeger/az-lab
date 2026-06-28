-- Migration 040: verified_at column + index + weekly audit RPC
-- Implements May 2026 research recommendation: explicit re-verification of high-recall memories.
-- recall_count tracks how often a memory is read; high-recall memories that have never been
-- re-verified by an agent (or were last verified > 30 days ago) are the highest-risk for silent
-- staleness. update_memory_verified() stamps verified_at = now(); weekly audit surfaces candidates.

-- 1. Column + index
ALTER TABLE memories ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_verified_at ON memories(verified_at);

-- 2. Update RPC: stamp verified_at = now() for a single memory
CREATE OR REPLACE FUNCTION public.update_memory_verified(p_memory_id uuid)
RETURNS TIMESTAMP WITH TIME ZONE
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := now();
BEGIN
  UPDATE memories
  SET verified_at = v_now
  WHERE id = p_memory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory % not found', p_memory_id;
  END IF;
  RETURN v_now;
END;
$$;

-- 3. Audit RPC: surface unverified high-recall memories (recall_count >= 10, importance_score >= 0.7,
--    verified_at NULL or > 30 days old). Returns rows ordered by recall_count DESC.
CREATE OR REPLACE FUNCTION public.unverified_high_recall_memories(
  p_min_recall_count integer DEFAULT 10,
  p_min_importance double precision DEFAULT 0.7,
  p_stale_days integer DEFAULT 30,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(
  id uuid,
  name text,
  type text,
  recall_count integer,
  importance_score double precision,
  verified_at timestamp with time zone,
  verification_age_days double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    m.id,
    m.name,
    m.type,
    COALESCE(m.recall_count, 0)::integer AS recall_count,
    COALESCE(m.importance_score, 0.5)::double precision AS importance_score,
    m.verified_at,
    CASE
      WHEN m.verified_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (now() - m.verified_at)) / 86400.0
    END AS verification_age_days
  FROM memories m
  WHERE COALESCE(m.recall_count, 0) >= p_min_recall_count
    AND COALESCE(m.importance_score, 0.5) >= p_min_importance
    AND (m.verified_at IS NULL OR m.verified_at < now() - (p_stale_days || ' days')::interval)
  ORDER BY m.recall_count DESC NULLS LAST, m.importance_score DESC
  LIMIT p_limit;
$$;

-- 4. Sentinel RPC for server-side migration detection
CREATE OR REPLACE FUNCTION public.apply_verified_at_if_missing()
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'verified_at'
  ) THEN
    ALTER TABLE memories ADD COLUMN verified_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_verified_at'
  ) THEN
    CREATE INDEX idx_memories_verified_at ON memories(verified_at);
  END IF;
  RETURN 'ok';
END;
$$;
