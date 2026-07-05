-- Migration 051: Auto-fill writer_agent on write (close the recurring NULL-provenance gap)
-- Source: 2026-06-29 daily research review (Wren), Governed Shared Memory arXiv:2606.24535
--
-- Migration 050 backfilled writer_agent ONCE. But cron/SQL write paths that bypass
-- the TypeScript deriveWriterAgent() (ai-memory-research-trigger, daily-* triggers,
-- dreaming_consolidate, weekly audits, direct claude-code execute_sql) keep landing
-- rows with writer_agent = NULL — the exact "silent cron memory injection" / provenance
-- collapse failure mode 2606.24535 flags. A one-time backfill cannot fix a recurring
-- write path, so this migration makes the fill automatic and permanent.
--
-- Design: a BEFORE INSERT/UPDATE trigger fills writer_agent FROM source ONLY when it
-- is NULL. It never overrides an explicit agent identity set by the MCP server's
-- deriveWriterAgent() AIP path, so the TS layer remains the source of truth and this
-- is purely a backstop for paths that bypass it. Rows whose source is not derivable
-- (legacy 'chat'/'system-design') stay NULL, same as the 050 backfill.

-- 1. Trigger function ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_writer_agent_from_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.writer_agent IS NULL THEN
    NEW.writer_agent := public.derive_writer_agent_from_source(NEW.source);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_writer_agent_from_source() IS
  'BEFORE INSERT/UPDATE backstop: fills writer_agent from source when NULL so cron/SQL write paths that bypass the MCP deriveWriterAgent() AIP path still carry provenance. Never overrides a non-NULL writer_agent (TS layer stays source of truth).';

-- 2. Trigger ──────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS memories_set_writer_agent_biu ON public.memories;
CREATE TRIGGER memories_set_writer_agent_biu
  BEFORE INSERT OR UPDATE OF source, writer_agent ON public.memories
  FOR EACH ROW
  EXECUTE FUNCTION public.set_writer_agent_from_source();

-- 3. One-shot reconciliation of rows written since the 050 backfill ───────────
-- Idempotent: only touches NULL rows that are now derivable.
UPDATE public.memories
   SET writer_agent = public.derive_writer_agent_from_source(source)
 WHERE writer_agent IS NULL
   AND public.derive_writer_agent_from_source(source) IS NOT NULL;
