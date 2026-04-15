-- Migration 014: hybrid_search_memories() + episodic consolidation job
-- 1. hybrid_search_memories() — clean public API function combining pgvector cosine
--    + tsvector ts_rank from BOTH search_vec (weighted A/B/C) and search_vector
--    (GENERATED ALWAYS) via Reciprocal Rank Fusion.
-- 2. consolidate_similar_memories() — merges memory pairs with cosine similarity > 0.90,
--    appending content from the lower-importance copy into the keeper, then deleting it.
-- 3. pg_cron job to run consolidation weekly (Sunday 03:00 UTC).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run

-- ─── 1. hybrid_search_memories() ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.hybrid_search_memories(
  p_query_text      text,
  p_query_embedding text        DEFAULT NULL,  -- JSON array string of floats
  p_match_threshold float       DEFAULT 0.25,
  p_match_count     int         DEFAULT 20,
  p_filter_type     text        DEFAULT NULL,
  p_agent_id        text        DEFAULT NULL
)
RETURNS TABLE(
  id              uuid,
  type            text,
  name            text,
  description     text,
  content         text,
  tags            text[],
  source          text,
  visibility      text,
  agent_id        text,
  importance_score float,
  access_count    integer,
  rrf_score       double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_embedding vector(768);
BEGIN
  -- Parse embedding if provided
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  RETURN QUERY
  WITH
  -- pgvector cosine similarity ranking
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY (m.embedding::vector) <=> v_embedding ASC
      ) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  -- BM25 via search_vec (weighted: name=A, description=B, content=C)
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  -- BM25 via search_vector (GENERATED ALWAYS — unweighted, broader recall)
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  -- Reciprocal Rank Fusion: k=60, weight vector=1.0, bm25_weighted=1.2, bm25_plain=0.8
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
      ) AS raw_rrf
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
  )
  SELECT
    m.id,
    m.type,
    m.name,
    m.description,
    m.content,
    m.tags,
    m.source,
    COALESCE(m.visibility, 'shared')::text   AS visibility,
    m.agent_id,
    COALESCE(m.importance_score, 0.5)::float AS importance_score,
    COALESCE(m.access_count,    0)::integer  AS access_count,
    -- Scale RRF by importance, dampen by access frequency (same formula as hybrid_recall)
    (rrf.raw_rrf
      * COALESCE(m.importance_score, 0.5)
      / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float))
    )::double precision                       AS rrf_score
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
  ORDER BY rrf_score DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_search_memories(text, text, float, int, text, text)
  TO service_role, authenticated;

-- ─── 2. consolidate_similar_memories() ───────────────────────────────────────
-- Finds memory pairs with cosine similarity > p_threshold (default 0.90).
-- For each pair: appends the lower-scored record's content into the keeper,
-- updates tags/source, then deletes the duplicate. Returns a summary row.

CREATE OR REPLACE FUNCTION public.consolidate_similar_memories(
  p_threshold  float DEFAULT 0.90,
  p_dry_run    boolean DEFAULT false
)
RETURNS TABLE(
  merged_count    integer,
  deleted_ids     uuid[],
  keeper_ids      uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted  uuid[] := '{}';
  v_keepers  uuid[] := '{}';
  v_merged   int    := 0;
  r          record;
BEGIN
  -- Find candidate pairs: cosine similarity > threshold, not already deleted
  FOR r IN
    SELECT
      a.id       AS id_a,
      b.id       AS id_b,
      a.name     AS name_a,
      b.name     AS name_b,
      a.content  AS content_a,
      b.content  AS content_b,
      a.tags     AS tags_a,
      b.tags     AS tags_b,
      COALESCE(a.importance_score, 0.5) AS imp_a,
      COALESCE(b.importance_score, 0.5) AS imp_b,
      1.0 - (a.embedding::vector <=> b.embedding::vector) AS cosine_sim
    FROM memories a
    JOIN memories b ON a.id < b.id  -- avoid duplicate pairs
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND a.type = b.type           -- only consolidate same-type memories
      AND (1.0 - (a.embedding::vector <=> b.embedding::vector)) > p_threshold
      AND a.id <> ALL(v_deleted)    -- skip already-deleted ids
      AND b.id <> ALL(v_deleted)
    ORDER BY cosine_sim DESC
    LIMIT 200  -- cap per run to avoid runaway merges
  LOOP
    -- Skip if either was already processed this run
    IF r.id_a = ANY(v_deleted) OR r.id_b = ANY(v_deleted) THEN
      CONTINUE;
    END IF;

    -- Keeper = higher importance_score; on tie, keep the one with higher id (newer)
    DECLARE
      v_keeper_id  uuid;
      v_delete_id  uuid;
      v_keep_cont  text;
      v_del_cont   text;
      v_merged_tags text[];
    BEGIN
      IF r.imp_a >= r.imp_b THEN
        v_keeper_id := r.id_a; v_keep_cont := r.content_a;
        v_delete_id := r.id_b; v_del_cont  := r.content_b;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_a || COALESCE(r.tags_b, '{}'::text[])));
      ELSE
        v_keeper_id := r.id_b; v_keep_cont := r.content_b;
        v_delete_id := r.id_a; v_del_cont  := r.content_a;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_b || COALESCE(r.tags_a, '{}'::text[])));
      END IF;

      IF NOT p_dry_run THEN
        -- Append duplicate's content to keeper (only if not already contained)
        IF v_keep_cont NOT LIKE '%' || LEFT(v_del_cont, 60) || '%' THEN
          UPDATE memories
          SET content  = v_keep_cont || E'\n\n[Consolidated from: ' || r.name_a || ' / ' || r.name_b || E']\n' || v_del_cont,
              tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        ELSE
          -- Content already included — just merge tags
          UPDATE memories
          SET tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        END IF;

        -- Log to memory_log before deleting
        INSERT INTO memory_log(memory_id, action, details, created_at)
        VALUES (v_delete_id, 'consolidated',
          jsonb_build_object(
            'keeper_id',   v_keeper_id,
            'cosine_sim',  r.cosine_sim,
            'threshold',   p_threshold
          ),
          now()
        ) ON CONFLICT DO NOTHING;

        -- Delete duplicate
        DELETE FROM memories WHERE id = v_delete_id;
      END IF;

      v_deleted := v_deleted || v_delete_id;
      v_keepers := v_keepers || v_keeper_id;
      v_merged  := v_merged + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_merged, v_deleted, v_keepers;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consolidate_similar_memories(float, boolean)
  TO service_role;

-- ─── 3. pg_cron weekly job (Sunday 03:00 UTC) ────────────────────────────────
-- Requires pg_cron extension (enabled on Supabase Pro+).
-- If pg_cron is not available, schedule manually or via Supabase Edge Functions.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.unschedule('weekly-memory-consolidation');
    PERFORM cron.schedule(
      'weekly-memory-consolidation',
      '0 3 * * 0',  -- Sunday 03:00 UTC
      $$SELECT consolidate_similar_memories(0.90, false)$$
    );
    RAISE NOTICE 'pg_cron job "weekly-memory-consolidation" scheduled (Sunday 03:00 UTC)';
  ELSE
    RAISE NOTICE 'pg_cron not available — run consolidate_similar_memories(0.90, false) manually or via Edge Function';
  END IF;
END;
$$;

-- ─── 4. Idempotent sentinel ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_consolidation_migration_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  fn_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'consolidate_similar_memories'
  ) INTO fn_exists;
  IF fn_exists THEN
    RETURN 'migration 014: hybrid_search_memories + consolidate_similar_memories present';
  ELSE
    RETURN 'WARNING: migration 014 not applied — run 014_hybrid_search_and_consolidation.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_consolidation_migration_if_missing()
  TO service_role, authenticated;
