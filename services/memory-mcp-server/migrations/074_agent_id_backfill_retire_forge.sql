-- Migration 074: backfill memories.agent_id, and retire the 'forge' agent.
--
-- WHY (agent_id): the 2026-06-02 provenance backfill drove agent_id nulls to 0,
--   and that memo asserted "new writes since 2026-04 populate agent_id +
--   provenance." That claim regressed — 338 of 813 rows were null again by
--   2026-07-24, every one of them created after the backfill.
--
-- ROOT CAUSE (fixed in src/index.ts alongside this migration): the remember
--   write path called deriveWriterAgent() and used the result for writer_agent,
--   but set agent_id ONLY when the caller passed it explicitly. Effectively no
--   caller does, so agent_id was null on virtually every automated write while
--   writer_agent was populated correctly. That is why 337 of the 338 nulls are
--   recoverable from writer_agent — they are the same value, one just never got
--   assigned.
--
-- WHY IT MATTERS: hybrid_recall filters on agent_id/visibility for per-agent
--   scoping. A null agent_id falls outside every agent-scoped filter. Harmless
--   while all rows are visibility=shared (the filter is a no-op), but it
--   silently breaks per-agent privacy the moment a private memory is written.
--
-- WHY (forge): Atlas absorbed both the Claude Desktop chat and code surfaces;
--   the "Agent Names" memory has recorded the merge since 2026-07-23 but the
--   agent roster, KNOWN_AGENTS, and 3 data rows still carried 'forge'.

-- 1. Recover agent_id from writer_agent — same derivation, just never assigned.
UPDATE memories
SET agent_id = writer_agent
WHERE agent_id IS NULL
  AND writer_agent IS NOT NULL;

-- 2. One straggler: source='web-research' (Tech Breakthrough watch, a
--    Wren-hosted CCR trigger on svc-podman-01) never derived a writer at all.
UPDATE memories
SET agent_id = 'wren', writer_agent = 'wren'
WHERE agent_id IS NULL
  AND source = 'web-research';

-- 3. Retire 'forge' -> 'atlas' on the 3 historical rows that carry it.
UPDATE memories SET agent_id     = 'atlas' WHERE agent_id     = 'forge';
UPDATE memories SET writer_agent = 'atlas' WHERE writer_agent = 'forge';

-- 4. Keep provenance.contributing_agent consistent with the recovered agent_id.
UPDATE memories
SET provenance = jsonb_set(
      COALESCE(provenance, '{}'::jsonb), '{contributing_agent}', to_jsonb(agent_id))
WHERE agent_id IS NOT NULL
  AND COALESCE(provenance->>'contributing_agent', '') IS DISTINCT FROM agent_id;

COMMENT ON COLUMN memories.agent_id IS
  'Owning agent. Defaults to deriveWriterAgent(source) at write time (migration 074 — do not rely on callers passing it explicitly). Used with visibility=private for agent-scoped hybrid_recall filtering. Valid: wren, iris, atlas, volt, hermes, lumen. forge retired 2026-07-24, remapped to atlas.';
