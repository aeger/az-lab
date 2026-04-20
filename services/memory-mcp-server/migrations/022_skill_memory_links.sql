-- Migration 022: Skill-memory auto-linking (A-Mem Zettelkasten extension)
--
-- Creates skill_memory_links table to record semantic proximity between
-- skills and recalled memories (cosine similarity >= threshold, default 0.75).
-- link_memories_to_skills(memory_ids, threshold) cross-joins skills × memories
-- on embedding distance and upserts matching pairs.
-- Called fire-and-forget after every recall that returns results.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Part A: skill_memory_links table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skill_memory_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES skills(id)   ON DELETE CASCADE,
  memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  similarity  double precision NOT NULL CHECK (similarity >= 0.0 AND similarity <= 1.0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_memory_links_skill_id   ON skill_memory_links (skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_memory_links_memory_id  ON skill_memory_links (memory_id);
CREATE INDEX IF NOT EXISTS idx_skill_memory_links_similarity ON skill_memory_links (similarity DESC);

-- ─── Part B: Auto-linking function ────────────────────────────────────────────
-- Cross-joins skills with the supplied memory IDs and upserts pairs that
-- exceed the similarity threshold. Only updates existing rows when a higher
-- similarity is observed (preserves strongest observed association).

CREATE OR REPLACE FUNCTION public.link_memories_to_skills(
  p_memory_ids            uuid[],
  p_similarity_threshold  double precision DEFAULT 0.75
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO skill_memory_links (skill_id, memory_id, similarity, updated_at)
  SELECT DISTINCT ON (s.id, m.id)
    s.id  AS skill_id,
    m.id  AS memory_id,
    (1.0 - (s.embedding::vector <=> m.embedding::vector))::double precision AS sim,
    now()
  FROM skills s
  CROSS JOIN memories m
  WHERE m.id = ANY(p_memory_ids)
    AND s.embedding IS NOT NULL
    AND m.embedding IS NOT NULL
    AND (1.0 - (s.embedding::vector <=> m.embedding::vector)) >= p_similarity_threshold
  ON CONFLICT (skill_id, memory_id) DO UPDATE
    SET similarity  = EXCLUDED.similarity,
        updated_at  = now()
  WHERE skill_memory_links.similarity < EXCLUDED.similarity;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.link_memories_to_skills(uuid[], double precision)
  TO service_role, authenticated;

-- ─── Part C: Idempotent sentinel ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_skill_memory_links_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  tbl_exists  boolean;
  func_exists boolean;
  parts text[] := ARRAY[]::text[];
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'skill_memory_links'
  ) INTO tbl_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'link_memories_to_skills'
  ) INTO func_exists;

  parts := parts || (CASE WHEN tbl_exists  THEN 'skill_memory_links ok'
                          ELSE 'WARNING: skill_memory_links missing' END);
  parts := parts || (CASE WHEN func_exists THEN 'link_memories_to_skills ok'
                          ELSE 'WARNING: link_memories_to_skills missing' END);

  RETURN 'migration 022: ' || array_to_string(parts, ', ');
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_skill_memory_links_if_missing()
  TO service_role, authenticated;
