-- Migration 025: discard_redundant_memories() — AgeMem selective discard
--
-- Finds near-duplicate memory pairs (cosine similarity > threshold), computes a
-- quality score for each, and deletes the lower-quality member of each pair.
-- Quality score: importance_score * 0.5 + recall_factor * 0.3 + access_factor * 0.2
-- where recall_factor = LEAST(recall_count/10, 1), access_factor = LEAST(access_count/20, 1)
--
-- Returns rows describing what was deleted (name, reason, quality_score).
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

CREATE OR REPLACE FUNCTION public.discard_redundant_memories(
  p_similarity_threshold FLOAT DEFAULT 0.92,
  p_max_discards        INTEGER DEFAULT 10,
  p_dry_run             BOOLEAN DEFAULT false
)
RETURNS TABLE(
  discarded_name   text,
  kept_name        text,
  similarity       float,
  discarded_score  float,
  kept_score       float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pair     RECORD;
  v_deleted  INTEGER := 0;
  v_a_score  FLOAT;
  v_b_score  FLOAT;
  v_worse_id uuid;
  v_worse_name text;
  v_better_name text;
  v_sim FLOAT;
BEGIN
  FOR v_pair IN (
    SELECT
      a.id AS a_id, a.name AS a_name,
      b.id AS b_id, b.name AS b_name,
      1.0 - (a.embedding::vector <=> b.embedding::vector) AS cosine_sim
    FROM memories a
    JOIN memories b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND (1.0 - (a.embedding::vector <=> b.embedding::vector)) >= p_similarity_threshold
    ORDER BY cosine_sim DESC
    LIMIT p_max_discards * 2
  ) LOOP
    EXIT WHEN v_deleted >= p_max_discards;

    -- Compute quality scores
    SELECT
      COALESCE(m.importance_score, 0.5) * 0.5
      + LEAST(COALESCE(m.recall_count, 0)::float / 10.0, 1.0) * 0.3
      + LEAST(COALESCE(m.access_count, 0)::float / 20.0, 1.0) * 0.2
    INTO v_a_score FROM memories m WHERE m.id = v_pair.a_id;

    SELECT
      COALESCE(m.importance_score, 0.5) * 0.5
      + LEAST(COALESCE(m.recall_count, 0)::float / 10.0, 1.0) * 0.3
      + LEAST(COALESCE(m.access_count, 0)::float / 20.0, 1.0) * 0.2
    INTO v_b_score FROM memories m WHERE m.id = v_pair.b_id;

    -- Pick the lower-quality one to discard
    IF v_a_score <= v_b_score THEN
      v_worse_id   := v_pair.a_id;
      v_worse_name := v_pair.a_name;
      v_better_name := v_pair.b_name;
    ELSE
      v_worse_id   := v_pair.b_id;
      v_worse_name := v_pair.b_name;
      v_better_name := v_pair.a_name;
    END IF;

    v_sim := v_pair.cosine_sim;

    IF NOT p_dry_run THEN
      -- Redirect links before deleting
      UPDATE memory_links SET source_id = CASE WHEN v_worse_id = source_id
        THEN CASE WHEN v_a_score <= v_b_score THEN v_pair.b_id ELSE v_pair.a_id END
        ELSE source_id END,
        target_id = CASE WHEN v_worse_id = target_id
        THEN CASE WHEN v_a_score <= v_b_score THEN v_pair.b_id ELSE v_pair.a_id END
        ELSE target_id END
      WHERE source_id = v_worse_id OR target_id = v_worse_id;

      DELETE FROM memories WHERE id = v_worse_id;
    END IF;

    discarded_name  := v_worse_name;
    kept_name       := v_better_name;
    similarity      := v_sim;
    discarded_score := LEAST(v_a_score, v_b_score);
    kept_score      := GREATEST(v_a_score, v_b_score);
    RETURN NEXT;

    v_deleted := v_deleted + 1;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.discard_redundant_memories(FLOAT, INTEGER, BOOLEAN)
  TO service_role, authenticated;

-- Idempotent sentinel
CREATE OR REPLACE FUNCTION public.apply_discard_redundant_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'discard_redundant_memories') THEN
    RETURN 'migration 025: discard_redundant_memories active';
  ELSE
    RETURN 'WARNING: discard_redundant_memories missing — re-apply 025_discard_redundant.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_discard_redundant_if_missing()
  TO service_role, authenticated;
