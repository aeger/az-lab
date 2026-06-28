-- Migration 049: visibility_scope enum for future per-user dashboard isolation
-- Source: 2026-06-26 daily research, REC P3 (Governed Shared Memory, scoped retrieval)
--
-- Scaffolding only. The dashboard's per-user gap (Heather/Jaden) is not live
-- yet; once LLDAP per-user tokens land, recall/list_memories will start
-- filtering on this column. Until then it stays nullable and unenforced so
-- existing behaviour is unchanged.
--
-- Values
--   agent-local   — only the writing agent (or row owner) can read it
--   team-shared   — all four agents (Wren/Iris/Atlas/Volt) can read (CURRENT DEFAULT)
--   user-private  — scoped to a specific human user (per-user dashboard rows)
--   tenant-global — anyone in the homelab, including dashboard guests
--   restricted    — admin-only; never returned by recall without explicit override

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_visibility_scope') THEN
    CREATE TYPE public.memory_visibility_scope AS ENUM (
      'agent-local', 'team-shared', 'user-private', 'tenant-global', 'restricted'
    );
  END IF;
END$$;

ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS visibility_scope public.memory_visibility_scope;

COMMENT ON COLUMN public.memories.visibility_scope IS
  'Future scoped-retrieval enum (migration 049, 2026-06-26). NULL = inherit legacy visibility/agent_scope. Will be enforced in hybrid_recall once dashboard per-user tokens land.';

CREATE INDEX IF NOT EXISTS memories_visibility_scope_idx
  ON public.memories (visibility_scope) WHERE visibility_scope IS NOT NULL;
