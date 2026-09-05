-- Migration 060: drop the access_count gate from flag_stale_memories()
--
-- WHY (audited live 2026-07-21, 763 active memories):
--   057 correctly killed the migration-027 predicate (access_count > 5 AND cold),
--   which was structurally unsatisfiable. But it kept a conjunct:
--
--     type IN ('project','reference')
--     AND COALESCE(verified_at, created_at) < now() - interval '14 days'
--     AND access_count >= 10        <-- this line
--
--   Live proof that 057 traded one dead predicate for a near-dead one:
--     575  rows are type project/reference
--     475  of those are verification-stale (>14d on coalesce(verified_at, created_at))
--      36  have access_count >= 10
--       0  satisfy BOTH  <-- the intersection is empty, again
--       0  rows carry staleness_candidate = true across the whole table
--
--   Median access_count is 0. Requiring a memory to be HOT before it is eligible
--   for a STALENESS flag is the same inverted logic 057 was written to kill, just
--   weaker: staleness is a property of verification age, and access frequency is
--   at best a statement about review PRIORITY. The sweep has reported zero since
--   057 shipped, which reads as "everything is fresh" when 475 rows are not.
--
-- THE FIX: access_count is demoted from an eligibility filter to a review-ordering
--   term (see the stale_memories_review_queue view below). Eligibility is now purely
--   verification age, with expires_at still winning when explicitly set.
--
-- EXPECTED BLAST RADIUS: ~475 rows flag on the first run. That is the correct
--   number, not a bug. It is deliberately paired with the ordered review queue
--   below so the backlog is worked in batches (hot-and-stale first) instead of
--   being dumped into a single unreviewable task.

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
  'Sets staleness_candidate from verification age alone (migration 060 dropped the access_count >= 10 eligibility gate; access_count is now only a review-ordering term in stale_memories_review_queue). expires_at, when set, overrides the 14-day rule. Idempotent: clears the flag when a row is re-verified. Called nightly by episodic_distill.py Phase 4 and every 24h by startStalenessJob in src/index.ts.';

-- The index from 057 leads on (type, access_count, ...); access_count is no longer
-- a predicate column, so give the new shape its own index and drop the stale one.
CREATE INDEX IF NOT EXISTS idx_memories_staleness_sweep_v2
  ON memories (type, verified_at, created_at)
  WHERE COALESCE(staleness_candidate, false) = false;

DROP INDEX IF EXISTS idx_memories_staleness_sweep;

-- Batched review queue. This is the other half of the fix: 475 flags are only
-- actionable if they can be worked in priority order. Hot-and-stale first —
-- a memory recalled 60 times that nobody has re-verified is the dangerous case
-- (MemGuard: stale-but-confident memories are served at full trust), while a
-- never-recalled 14-day-old row is nearly harmless.
CREATE OR REPLACE VIEW public.stale_memories_review_queue AS
SELECT
  m.id,
  m.name,
  m.type,
  m.trust_tier,
  COALESCE(m.access_count, 0) AS access_count,
  m.verified_at,
  m.created_at,
  m.expires_at,
  (now() - COALESCE(m.verified_at, m.created_at))::interval AS unverified_for,
  m.verified_at IS NULL AS never_verified,
  ROW_NUMBER() OVER (
    ORDER BY
      (m.expires_at IS NOT NULL AND m.expires_at <= now()) DESC,  -- explicit TTL expiry first
      COALESCE(m.access_count, 0) DESC,                           -- then hot-and-stale
      COALESCE(m.verified_at, m.created_at) ASC                   -- then oldest-unverified
  ) AS review_rank
FROM memories m
WHERE COALESCE(m.is_active, true) IS NOT FALSE
  AND COALESCE(m.staleness_candidate, false) = true;

COMMENT ON VIEW public.stale_memories_review_queue IS
  'Ordered backlog of staleness_candidate rows for BATCHED review. Pull with "WHERE review_rank BETWEEN x AND y" — do not review the whole set in one task. Ordering: expired-TTL first, then highest access_count (hot-and-stale = most dangerous), then oldest-unverified. access_count lives here as a priority term only; migration 060 removed it from flag_stale_memories() eligibility.';

REVOKE EXECUTE ON FUNCTION public.flag_stale_memories() FROM anon, authenticated;
