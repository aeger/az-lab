-- Migration 057: repair flag_stale_memories() + wire the expires_at TTL lane
--
-- ⚠ SUPERSEDED IN PART BY MIGRATION 060 (2026-07-21). Two corrections:
--   1. The `access_count >= 10` conjunct below left the predicate near-dead —
--      0 of 763 rows satisfied it together with the 14-day rule. 060 drops it.
--   2. The comments below say this function is called by episodic_distill.py
--      "Phase 3". That is WRONG — it is Phase 4. Phase 3 is the weekly 30-day
--      consolidation (episodic_distill.py:726, run from --weekly). The task
--      definition's "Phase 4" was the correct one.
--
-- WHY (audited live 2026-07-15, 757 memories):
--   staleness_candidate was 0/757 — not because the lane was missing, but because
--   the migration 027 predicate is structurally unsatisfiable:
--
--     access_count > 5 AND COALESCE(last_accessed, ...) < now() - 21 days
--
--   A memory with access_count > 5 is BY DEFINITION one that keeps getting recalled,
--   so last_accessed is always recent. The two conditions never co-occur.
--   Live proof: 58 rows match access_count > 5, 493 match the 21-day cold test,
--   and the intersection is exactly 0. The job has run every 24h since April
--   flagging nothing, silently.
--
--   027 also excluded type='project', which is where the live-state records live
--   (e.g. 'memory-mcp-server' — the most-recalled record in the DB, 23 days
--   unverified and demonstrably wrong on two facts as of this migration).
--
-- THE FIX: key staleness off VERIFICATION age, not ACCESS recency. A hot record
-- that nobody has re-verified is exactly the dangerous case (MemGuard: stale-but-
-- confident memories are worse than missing ones, because retrieval serves them
-- at full trust).
--
-- NOTE on the date column: do NOT use updated_at. All 757 rows are touched nightly
-- by the decay/pagerank jobs, so updated_at is always < 2 days old and carries no
-- staleness signal. coalesce(verified_at, created_at) is the real "last time a human
-- or agent vouched for this" clock. Using updated_at here would flag only the 20 rows
-- that already have verified_at set — a chicken-and-egg where never-verified memories
-- can never be flagged, and so are never verified.

-- 1. Per-record TTL column (Migration 054 added it; ensure present + indexed)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_memories_staleness_sweep
  ON memories (type, access_count, verified_at, created_at)
  WHERE COALESCE(staleness_candidate, false) = false;

CREATE INDEX IF NOT EXISTS idx_memories_expires_at
  ON memories (expires_at) WHERE expires_at IS NOT NULL;

-- 2. Replace the predicate. Same function name so the existing 24h caller in
--    src/index.ts (startStalenessJob) and the new distill Phase 3 both drive
--    one shared rule — no competing lanes.
CREATE OR REPLACE FUNCTION public.flag_stale_memories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  flagged_count integer;
BEGIN
  -- Single source of truth for "is this row stale right now".
  -- expires_at, when set, WINS over the blanket age rule (explicit TTL beats heuristic).
  WITH target AS (
    SELECT
      id,
      CASE
        WHEN expires_at IS NOT NULL
          THEN expires_at <= now()
        ELSE
          type IN ('project', 'reference')
          AND COALESCE(verified_at, created_at) < now() - interval '14 days'
          AND access_count >= 10
      END AS should_flag
    FROM memories
    WHERE COALESCE(is_active, true) IS NOT FALSE
  )
  UPDATE memories m
  SET staleness_candidate = t.should_flag
  FROM target t
  WHERE m.id = t.id
    AND COALESCE(m.staleness_candidate, false) IS DISTINCT FROM t.should_flag;

  GET DIAGNOSTICS flagged_count = ROW_COUNT;
  RETURN flagged_count;
END;
$$;

COMMENT ON FUNCTION public.flag_stale_memories() IS
  'Sets staleness_candidate from verification age (not access recency). expires_at, when set, overrides the 14-day rule. Idempotent: clears the flag when a row is re-verified. Called nightly by episodic_distill.py Phase 3 and every 24h by startStalenessJob.';

-- 3. Re-verification must clear the flag, otherwise a verified row stays labelled
--    +stale until the next nightly sweep. Folded into the EXISTING verify RPC
--    (src/index.ts:2471 already calls it) rather than adding a parallel function.
CREATE OR REPLACE FUNCTION public.update_memory_verified(p_memory_id uuid)
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := now();
BEGIN
  UPDATE memories
  SET verified_at = v_now,
      staleness_candidate = false
  WHERE id = p_memory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory % not found', p_memory_id;
  END IF;
  RETURN v_now;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.flag_stale_memories() FROM anon, authenticated;
