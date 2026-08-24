-- 131: memory_log_action_check rejected 'supersede', so supersede_memory()'s
-- audit insert has ALWAYS failed. It is wrapped in EXCEPTION WHEN OTHERS THEN
-- NULL, so it failed silently: 0 supersede rows in memory_log since migration
-- 063 introduced the call. An unlogged mutation is an unauditable one --
-- observed 2026-08-24 when remember() auto-superseded 7 unrelated dated
-- research logs and memory_log recorded nothing.
--
-- Audit-only change. No behaviour change to supersede_memory itself.
ALTER TABLE memory_log DROP CONSTRAINT IF EXISTS memory_log_action_check;
ALTER TABLE memory_log ADD CONSTRAINT memory_log_action_check
  CHECK (action = ANY (ARRAY['create','update','delete','supersede','unsupersede']));
