-- Migration 067: remove updated_at from the standing-value recency term.
--
-- WHY (caught by running 065 twice, 2026-07-23): amac_standing_value() used
--   COALESCE(last_accessed_at, updated_at, created_at) as its recency anchor.
--   memories carries an unconditional BEFORE UPDATE trigger (memories_updated_at
--   -> update_updated_at()), so ANY write to a row - including assign_memory_tiers()
--   writing memory_tier itself - stamps updated_at = now().
--
--   Result: the tier job inflated the recency term of every row it touched, so the
--   hot tier grew 78 -> 171 between two consecutive runs with no underlying change.
--   The function was self-reinforcing and non-idempotent: housekeeping writes were
--   being read back as evidence of freshness.
--
-- FIX: anchor recency on COALESCE(last_accessed_at, created_at). Both are semantic
--   - when it was last USED, else when it was BORN. updated_at is an operational
--   timestamp mutated by background jobs and carries no signal about usefulness.
--
-- BLAST RADIUS: hybrid_recall does NOT reference updated_at (verified live), so
--   recall ranking was never affected. The damage was contained to memory_tier,
--   which is recomputed idempotently by the next assign_memory_tiers() run.

CREATE OR REPLACE FUNCTION public.amac_standing_value(
  p_last_accessed_at timestamptz,
  p_updated_at       timestamptz,
  p_created_at       timestamptz,
  p_access_count     integer,
  p_novelty          double precision,
  p_importance       double precision
) RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- p_updated_at is accepted for signature stability but DELIBERATELY IGNORED.
  -- See migration 067: it is trigger-mutated and therefore not a freshness signal.
  SELECT (
      0.25 * EXP(-0.1 * GREATEST(
               EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed_at, p_created_at))) / 86400.0, 0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(p_novelty, 0.5)
    + 0.25 * COALESCE(p_importance, 0.5)
  ) / 0.85
$$;

COMMENT ON FUNCTION public.amac_standing_value IS
  'Query-independent A-MAC composite (migrations 065/067): 0.25 recency + 0.20 access_freq + 0.15 novelty + 0.25 importance, renormalized to 0..1. Recency anchors on COALESCE(last_accessed_at, created_at) - updated_at is ignored because a BEFORE UPDATE trigger makes it non-semantic.';
