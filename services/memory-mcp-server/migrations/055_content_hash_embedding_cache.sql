-- Migration 055: content_hash embedding cache (2026-07-08 self-improvement research REC #3)
-- Adds a SHA-256 hash of the embed input (name + description + content) to memories so the
-- remember tool can skip the Ollama embed call when a re-index/re-write is byte-identical.
-- Reported to skip ~90% of an ingest run's embed calls. Compute-only optimization on the
-- shared VM — no change to retrieval (hybrid_recall) behavior.
--
-- Prior state verified 2026-07-08: hybrid RRF retrieval (hybrid_recall, 6 lanes) and the
-- TEI cross-encoder rerank (RECs #1/#2) were already deployed; agent_scope (REC #4) column +
-- hybrid_recall filtering already existed. Only this content_hash cache was missing.

-- 1. Column (nullable — populated lazily on next write; NULL = "unknown, must embed")
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash text DEFAULT NULL;

-- 2. Index to make the "same-name, same-hash" lookup cheap
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

-- 3. Sentinel RPC for server-side migration detection (matches existing convention)
CREATE OR REPLACE FUNCTION public.apply_content_hash_if_missing()
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'content_hash'
  ) THEN
    ALTER TABLE memories ADD COLUMN content_hash text DEFAULT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_content_hash'
  ) THEN
    CREATE INDEX idx_memories_content_hash ON memories(content_hash);
  END IF;
  RETURN 'ok';
END;
$$;
