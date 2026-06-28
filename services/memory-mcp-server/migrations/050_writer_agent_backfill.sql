-- Migration 050: Backfill writer_agent for historical rows
-- Source: 2026-06-28 daily research (Forge), Governed Shared Memory arXiv 2606.24535
--
-- Migration 048 added writer_agent but only the explicit-agent_id path populated
-- it (2 rows in claude-code, 4 rows total of 608). The cron-injected rows
-- (ai-memory-research-trigger, daily-self-improvement-research-trigger,
-- consolidation, etc.) all had NULL writer_agent — the silent-pollution
-- failure mode that 2606.24535 flags as "cron memory injection (40,020 trials)".
--
-- This migration backfills writer_agent from the source field using the same
-- mapping the TypeScript deriveWriterAgent() applies to new writes. After
-- this, every row has provenance traceable to a specific agent (wren, iris,
-- atlas, forge, volt, hermes, lumen) or stays NULL when not derivable.

CREATE OR REPLACE FUNCTION public.derive_writer_agent_from_source(p_source text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text := lower(coalesce(p_source, ''));
  agents text[] := ARRAY['wren','iris','atlas','forge','volt','hermes','lumen'];
  a text;
BEGIN
  IF s = '' THEN RETURN NULL; END IF;
  -- Exact match on known agent
  FOREACH a IN ARRAY agents LOOP
    IF s = a THEN RETURN a; END IF;
  END LOOP;
  -- Token match: agent appears bounded by string start/end or non-alphanum
  FOREACH a IN ARRAY agents LOOP
    IF s ~ ('(^|[^a-z0-9])' || a || '([^a-z0-9]|$)') THEN
      RETURN a;
    END IF;
  END LOOP;
  -- Surface conventions
  IF s = 'claude-ai' OR s = 'cowork' OR s LIKE 'cowork-%' THEN RETURN 'iris'; END IF;
  -- Wren-hosted cron / claude-code sources (svc-podman-01)
  IF s = 'claude-code' OR s = 'consolidation' OR s = 'dreaming_consolidate'
     OR s LIKE '%-trigger' OR s LIKE 'ccr-%' OR s LIKE 'daily-%' THEN
    RETURN 'wren';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.derive_writer_agent_from_source(text) IS
  'Maps the free-text source field to a known agent identity. Mirrors deriveWriterAgent() in memory-mcp-server src/index.ts so backfills and new writes use the same rules.';

-- Backfill: only fill NULL writer_agent rows; never overwrite existing values.
UPDATE public.memories
   SET writer_agent = public.derive_writer_agent_from_source(source)
 WHERE writer_agent IS NULL
   AND public.derive_writer_agent_from_source(source) IS NOT NULL;
