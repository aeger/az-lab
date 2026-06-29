-- Migration 038: Agent read watermarks for multi-agent stale-context detection
--
-- Addresses the #1 documented production failure mode for multi-agent shared memory:
-- "context inconsistency across agent memory stores." Each agent records the last
-- timestamp at which it observed memory state. check_stale_context() returns any
-- memories from a candidate set that have been modified in memory_log since the
-- agent's watermark — so the caller can refresh stale memories before acting on them.

CREATE TABLE IF NOT EXISTS public.agent_read_watermarks (
  agent_name        TEXT        PRIMARY KEY,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_read_watermarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.agent_read_watermarks;
CREATE POLICY "service_role_all" ON public.agent_read_watermarks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_read" ON public.agent_read_watermarks;
CREATE POLICY "authenticated_read" ON public.agent_read_watermarks
  FOR SELECT TO authenticated USING (true);

-- Returns memories from p_memory_ids that have been mutated since the agent's
-- last_seen_at watermark. Empty array result == nothing stale.
CREATE OR REPLACE FUNCTION public.check_stale_context(
  p_agent_name TEXT,
  p_memory_ids UUID[]
) RETURNS TABLE (
  memory_id        UUID,
  memory_name      TEXT,
  action           TEXT,
  last_modified_at TIMESTAMPTZ,
  changed_by       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_watermark TIMESTAMPTZ;
BEGIN
  SELECT last_seen_at INTO v_watermark
  FROM public.agent_read_watermarks
  WHERE agent_name = p_agent_name;

  -- Unknown agent: treat as fresh (no stale rows). Caller should bump watermark.
  IF v_watermark IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (ml.memory_id)
    ml.memory_id,
    m.name,
    ml.action,
    ml.created_at,
    ml.source
  FROM public.memory_log ml
  LEFT JOIN public.memories m ON m.id = ml.memory_id
  WHERE ml.memory_id = ANY(p_memory_ids)
    AND ml.created_at > v_watermark
    AND ml.source IS DISTINCT FROM p_agent_name  -- self-writes are not stale to self
  ORDER BY ml.memory_id, ml.created_at DESC;
END;
$$;

-- Bumps the agent's watermark to now(). Call after the agent has processed the
-- memories returned by a recall and any stale-context warnings.
CREATE OR REPLACE FUNCTION public.update_read_watermark(
  p_agent_name TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  INSERT INTO public.agent_read_watermarks (agent_name, last_seen_at, updated_at)
  VALUES (p_agent_name, v_now, v_now)
  ON CONFLICT (agent_name) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
        updated_at   = EXCLUDED.updated_at;
  RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_stale_context(TEXT, UUID[]) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.update_read_watermark(TEXT) TO service_role, authenticated;
