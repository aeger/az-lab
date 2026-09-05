-- Migration 059: agent_episodes semantic retrieval (MemRL pattern — 2026-07-16 research P1)
--
-- agent_episodes rows were write-only: recorded for the nightly distill but never
-- semantically recallable at task start. Adds an embedding column (summary +
-- outcome + learnings, nomic-embed-text 768-dim via the standard Ollama path) and
-- a match_episodes RPC mirroring match_memories. v5.13.0 embeds on record_episode
-- writes, backfills existing rows via startEmbeddingBackfillJob, and gives
-- recall_episodes a semantic `query` param.

-- NOTE: pgvector lives in the `extensions` schema on azlab-memory — the operator
-- <=> is not visible from a search_path of only public/pg_temp (SQL-language
-- function bodies are validated at CREATE time), hence the explicit
-- extensions.vector types and 'extensions' in search_path below.

ALTER TABLE agent_episodes
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(768);

CREATE INDEX IF NOT EXISTS idx_agent_episodes_embedding
  ON agent_episodes USING hnsw (embedding extensions.vector_cosine_ops);

CREATE OR REPLACE FUNCTION public.match_episodes(
  query_embedding extensions.vector,
  match_count integer DEFAULT 5,
  filter_agent text DEFAULT NULL,
  filter_status text DEFAULT NULL
)
RETURNS TABLE(
  id uuid, agent text, task_id uuid,
  started_at timestamptz, ended_at timestamptz,
  status text, summary text, input_summary text,
  outcome text, learnings text, memories_consulted uuid[],
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT id, agent, task_id, started_at, ended_at, status, summary, input_summary,
    outcome, learnings, memories_consulted,
    1 - (embedding <=> query_embedding) AS similarity
  FROM agent_episodes
  WHERE embedding IS NOT NULL
    AND (filter_agent IS NULL OR agent = filter_agent)
    AND (filter_status IS NULL OR status = filter_status)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
