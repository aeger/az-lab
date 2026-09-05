-- 132: second reason supersede_memory()'s audit insert silently failed.
-- memory_log.source is NOT NULL with no default, and the RPC inserts only
-- (memory_id, action, details). Migration 131 fixed the CHECK; the NOT NULL
-- violation was still swallowed by the same EXCEPTION WHEN OTHERS THEN NULL.
ALTER TABLE memory_log ALTER COLUMN source SET DEFAULT 'system';
