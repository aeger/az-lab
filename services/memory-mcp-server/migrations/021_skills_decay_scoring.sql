-- Migration 021: Skills decay scoring — last_used, success_rate, updated match_skills RPC
--
-- Adds episodic feedback columns to skills table to enable decay-based ranking:
--   last_used (timestamptz)  — set on every recall_skill hit
--   success_rate (float)     — Bayesian incremental mean: (0.0 failure … 1.0 success)
--
-- Updates match_skills() to composite-score results using:
--   0.50 × cosine similarity
--   0.20 × recency decay (exp, 30-day half-life)
--   0.15 × popularity (log-normalized use_count)
--   0.15 × success rate (default 0.5 when unknown)
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Part A: Add decay columns to skills ──────────────────────────────────────

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS last_used timestamptz,
  ADD COLUMN IF NOT EXISTS success_rate float CHECK (success_rate IS NULL OR (success_rate >= 0.0 AND success_rate <= 1.0));

CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills(last_used DESC NULLS LAST);

-- ─── Part B: Updated match_skills RPC with decay composite scoring ─────────────

-- Drop old signature first (match_count only)
DROP FUNCTION IF EXISTS public.match_skills(vector, int);
DROP FUNCTION IF EXISTS public.match_skills(text, int);

CREATE OR REPLACE FUNCTION public.match_skills(
  query_embedding text,
  match_count int DEFAULT 5
)
RETURNS TABLE(
  id uuid,
  name text,
  title text,
  description text,
  content text,
  triggers text[],
  platforms text[],
  use_count int,
  last_used timestamptz,
  success_rate float,
  similarity float,
  composite_score float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_embedding vector(768);
  v_lambda float := 0.0231; -- 30-day half-life: ln(2)/30
BEGIN
  v_embedding := query_embedding::vector;

  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.title,
    s.description,
    s.content,
    s.triggers,
    s.platforms,
    COALESCE(s.use_count, 0)::int,
    s.last_used,
    s.success_rate,
    (1.0 - (s.embedding::vector <=> v_embedding))::float AS similarity,
    -- Composite decay score
    (
      0.50 * (1.0 - (s.embedding::vector <=> v_embedding))
      + 0.20 * EXP(-v_lambda * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(s.last_used, s.updated_at, s.created_at))) / 86400.0,
          0.0
        ))
      + 0.15 * (LN(1.0 + COALESCE(s.use_count, 0)::float) / LN(101.0))
      + 0.15 * COALESCE(s.success_rate, 0.5)
    )::float AS composite_score
  FROM skills s
  WHERE s.embedding IS NOT NULL
    AND (1.0 - (s.embedding::vector <=> v_embedding)) > 0.1
  ORDER BY composite_score DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_skills(text, int) TO service_role, authenticated;

-- ─── Part C: Idempotent sentinel ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_skills_decay_scoring_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  col_last_used boolean;
  col_success_rate boolean;
  func_body text;
  parts text[] := ARRAY[]::text[];
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'skills' AND column_name = 'last_used'
  ) INTO col_last_used;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'skills' AND column_name = 'success_rate'
  ) INTO col_success_rate;

  IF col_last_used THEN
    parts := parts || 'last_used ok';
  ELSE
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used timestamptz;
    CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills(last_used DESC NULLS LAST);
    parts := parts || 'last_used added';
  END IF;

  IF col_success_rate THEN
    parts := parts || 'success_rate ok';
  ELSE
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS success_rate float;
    parts := parts || 'success_rate added';
  END IF;

  -- Check match_skills has composite_score
  SELECT pg_get_functiondef(p.oid) INTO func_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'match_skills'
  LIMIT 1;

  IF func_body LIKE '%composite_score%' THEN
    parts := parts || 'match_skills composite_score ok';
  ELSE
    parts := parts || 'WARNING: match_skills missing composite_score — re-apply 021_skills_decay_scoring.sql';
  END IF;

  RETURN 'migration 021: ' || array_to_string(parts, ', ');
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_skills_decay_scoring_if_missing() TO service_role, authenticated;
