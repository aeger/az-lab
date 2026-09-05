-- Migration 054: propagation governance dimension for 4-agent shared memory
-- Source: 2026-07-05 daily research, REC #3 (Governed Shared Memory arXiv 2606.24535,
--          Mesh Memory Protocol arXiv 2604.19540).
--
-- The governed-shared-memory discipline models memory as operational state with
-- FOUR governance dimensions:
--   1. scope       — WHO can read it            → visibility_scope enum (migration 049) ✓
--   2. time        — temporal supersession      → superseded_by / supersede_memory ✓
--   3. provenance  — WHO wrote it / trust        → source, writer_agent, provenance jsonb,
--                                                   trust_tier (migrations 041/048/050/051) ✓
--   4. propagation — HOW/whether it SPREADS      → THIS MIGRATION (was the missing 4th)
--
-- Scaffolding only, mirroring migration 049. Column is nullable + unenforced so
-- existing behaviour is unchanged. NULL = inherit legacy default (team-shared,
-- retrievable by all four agents via recall). A consumer (cross-agent push /
-- attention routing on the agent bus) can start honouring it later.
--
-- Values
--   broadcast  — actively surfaced to all agents on write (agent-bus push / attention)
--   shared     — retrievable by any agent via recall, but NOT pushed (typical team default)
--   local      — stays with the writing agent's working context; not surfaced cross-agent
--   ephemeral  — short-lived working note; not propagated, expected to decay/consolidate away
--   sealed     — never propagates (secrets / restricted); recall only with explicit override

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_propagation') THEN
    CREATE TYPE public.memory_propagation AS ENUM (
      'broadcast', 'shared', 'local', 'ephemeral', 'sealed'
    );
  END IF;
END$$;

ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS propagation public.memory_propagation;

COMMENT ON COLUMN public.memories.propagation IS
  'Governance dim 4 of 4 (migration 054, 2026-07-05): how a memory spreads across the '
  'Wren/Iris/Atlas/Forge shared DB. NULL = inherit legacy default (team-shared, recall-visible, '
  'not pushed). Unenforced scaffolding until cross-agent propagation routing consumes it — '
  'mirrors the visibility_scope (migration 049) rollout pattern.';

CREATE INDEX IF NOT EXISTS memories_propagation_idx
  ON public.memories (propagation) WHERE propagation IS NOT NULL;
