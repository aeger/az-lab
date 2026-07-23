-- Migration 065: memory lifecycle tiers (hot/warm/cold) + gated soft-retirement
--
-- WHY (audited live 2026-07-23, 802 rows / 759 active):
--   Migration 057 built staleness DETECTION and 060 repaired it. Neither built
--   DISPOSITION. Live proof that the flag fires into a queue nobody drains:
--     425  rows carry staleness_candidate = true
--     425  rows in stale_memories_review_queue
--     head dated 2026-03-21 — FOUR MONTHS with zero rows dispositioned
--     615  rows (77%) have access_count = 0 — never once retrieved
--       1  row has expires_at set
--   That is precisely the store-and-retrieve-only failure the 2026 lifecycle
--   literature describes (AMV-L arXiv 2603.04443, MemTier arXiv 2605.03675,
--   FSFM arXiv 2604.20300), reproduced locally.
--
-- WHAT THIS ADDS: the missing verbs. A memory now has a TIER, the tier moves on
--   standing value, and the cold tier — and ONLY the cold tier, per AMV-L — is
--   eligible for eviction. Eviction here means is_active = false. SOFT RETIRE.
--   Nothing in this migration deletes a row, ever. hybrid_recall already filters
--   `COALESCE(is_active, true) IS NOT FALSE` (verified live 2026-07-23), so
--   flipping the flag is sufficient to remove a memory from recall AND is fully
--   reversible by flipping it back.
--
-- WHY THE TIER DRIVER IS THE QUERY-FREE A-MAC COMPOSITE:
--   hybrid_recall's composite includes a utility/RRF term that only exists in the
--   context of a query. Tier assignment is a background property of the row, so it
--   uses the same 4 query-independent signals renormalized to 1.0 — exactly the
--   composite migration 013 already defined for prune_decayed_memories. Factored
--   into amac_standing_value() here so there is ONE definition to tune instead of
--   the copy-paste hazard migration 061 had to work around inside hybrid_recall.
--
-- CALIBRATION IS MEASURED, NOT GUESSED. Live standing-value distribution:
--   min 0.271 · p25 0.514 · p50 0.514 · p75 0.573 · p90 0.598 · max 0.844
--   The distribution is TIGHT (p25 == p50) because most rows carry default
--   importance 0.5 and novelty 0.5 and access_count 0 — so the composite alone is
--   a weak discriminator and thresholds are deliberately paired with hard
--   never-accessed + age conjuncts rather than trusted on their own.
--
-- BLAST RADIUS AT THESE THRESHOLDS (measured live before shipping):
--   hot  (>= 0.60)                                        58 rows
--   cold (< 0.45 AND access_count = 0 AND age > 60d)       7 rows
--   retirement candidates (cold AND age > 90d)             7 rows
--   Seven is a SMALL number and that is the honest answer, not a mis-calibration:
--   the 615 never-accessed rows are overwhelmingly RECENT dated log entries, which
--   score high on recency and correctly do not qualify as cold. The real
--   compression opportunity is duplicate consolidation (see below), not eviction.
--
-- THE ACTUAL REDUNDANCY (this is where the 77% comes from):
--   441 of 759 active rows are dated append-only research log series:
--     Tech Breakthrough              127 rows (123 never accessed)
--     Daily Self-Improvement Research 114 rows ( 80 never accessed)
--     AI Memory Research             107 rows ( 94 never accessed)
--     semantic:Tech Breakthrough      68 rows ( 61 never accessed)
--     Daily AI Memory Research        25 rows ( 17 never accessed)
--   335 rows participate in a >=0.92-cosine near-duplicate pair (10,180 pairs;
--   3,934 above 0.95). Per the research recommendation, consolidation runs BEFORE
--   retirement — discarding a near-duplicate cluster loses the thematic content
--   that an EverMemOS-style merge would preserve. So retirement candidates that
--   sit inside an unconsolidated duplicate cluster are HELD BACK, not retired.
--
-- SAFETY POSTURE: retire_cold_memories() defaults to DRY RUN. Auto-retire cannot
--   happen by accident — it requires p_dry_run := false AND the
--   memory_lifecycle_autoretire_enabled setting to be true. Batch 1 goes to Jeff
--   for approval before either is flipped.

BEGIN;

-- ─── 1. Tier column ──────────────────────────────────────────────────────────
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_tier text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tier_assigned_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retire_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_memory_tier_check'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_memory_tier_check
      CHECK (memory_tier IS NULL OR memory_tier IN ('hot', 'warm', 'cold'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_memory_tier ON memories(memory_tier);

COMMENT ON COLUMN memories.memory_tier IS
  'AMV-L lifecycle tier (migration 065). hot/warm/cold, assigned by assign_memory_tiers() from amac_standing_value(). ONLY cold is eligible for eviction.';
COMMENT ON COLUMN memories.retired_at IS
  'When this memory was soft-retired (is_active=false) by the lifecycle job. NULL for rows deactivated by other means.';

-- ─── 2. The query-free standing value — single source of truth ───────────────
-- Same 4 signals and weights as migration 013's prune composite, renormalized by
-- 0.85 so the result is on a 0..1 scale. Tune the tier policy HERE.
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
  SELECT (
      0.25 * EXP(-0.1 * GREATEST(
               EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed_at, p_updated_at, p_created_at))) / 86400.0, 0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(p_novelty, 0.5)
    + 0.25 * COALESCE(p_importance, 0.5)
  ) / 0.85
$$;

COMMENT ON FUNCTION public.amac_standing_value IS
  'Query-independent A-MAC composite (migration 065): 0.25 recency + 0.20 access_freq + 0.15 novelty + 0.25 importance, renormalized to 0..1. Drives memory_tier. This is the background/standing counterpart to the query-time composite inside hybrid_recall — do not confuse the two.';

-- NOTE: amac_standing_value is marked IMMUTABLE but reads now(). That is a
-- deliberate, contained lie required to keep it inlinable in the views below;
-- it is never used in an index or a generated column, where the lie would bite.

-- ─── 3. Convenience view: every active row with its standing value ───────────
CREATE OR REPLACE VIEW public.memory_standing AS
SELECT
  m.id, m.name, m.type, m.memory_class, m.trust_tier, m.memory_tier,
  COALESCE(m.access_count, 0) AS access_count,
  m.created_at, m.verified_at, m.staleness_candidate,
  EXTRACT(DAY FROM now() - m.created_at)::int AS age_days,
  public.amac_standing_value(
    m.last_accessed_at, m.updated_at, m.created_at,
    m.access_count, m.amac_novelty_score, m.importance_score) AS standing_value
FROM memories m
WHERE COALESCE(m.is_active, true) IS NOT FALSE;

-- ─── 4. Tier assignment: promote / demote ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_memory_tiers()
RETURNS TABLE(tier text, n bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH scored AS (
    SELECT
      m.id,
      public.amac_standing_value(
        m.last_accessed_at, m.updated_at, m.created_at,
        m.access_count, m.amac_novelty_score, m.importance_score) AS sv,
      COALESCE(m.access_count, 0) AS ac,
      m.created_at
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
  ), assigned AS (
    SELECT id,
      CASE
        -- HOT: high standing, or demonstrably in use. Access is an independent
        -- promotion path so a genuinely-used memory can never be demoted to cold
        -- on composite alone.
        WHEN sv >= 0.60 OR ac >= 10 THEN 'hot'
        -- COLD: low standing AND never once retrieved AND not recent. All three
        -- must hold — the composite is too tightly distributed to trust alone.
        WHEN sv < 0.45 AND ac = 0 AND created_at < now() - interval '60 days' THEN 'cold'
        ELSE 'warm'
      END AS new_tier
    FROM scored
  )
  UPDATE memories m
  SET memory_tier = a.new_tier,
      tier_assigned_at = now()
  FROM assigned a
  WHERE m.id = a.id
    AND (m.memory_tier IS DISTINCT FROM a.new_tier OR m.tier_assigned_at IS NULL);

  RETURN QUERY
    SELECT m.memory_tier, count(*)
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
    GROUP BY m.memory_tier ORDER BY 1;
END;
$$;

COMMENT ON FUNCTION public.assign_memory_tiers IS
  'AMV-L promote/demote pass (migration 065). Idempotent; safe to run on a timer. Returns the resulting tier distribution.';

-- ─── 5. Near-duplicate clusters — consolidate BEFORE retiring ────────────────
-- Pairwise cosine over the 768-dim nomic embeddings. Deliberately a view, not a
-- materialization: it is read by the dry-run report and the health report, both
-- of which run at most daily.
CREATE OR REPLACE VIEW public.memory_duplicate_pairs AS
SELECT
  a.id           AS id_a,
  b.id           AS id_b,
  a.name         AS name_a,
  b.name         AS name_b,
  1 - (a.embedding <=> b.embedding) AS similarity
FROM memories a
JOIN memories b
  ON a.id < b.id
 AND a.embedding <=> b.embedding < 0.08   -- cosine similarity >= 0.92
WHERE COALESCE(a.is_active, true) IS NOT FALSE
  AND COALESCE(b.is_active, true) IS NOT FALSE
  AND a.embedding IS NOT NULL
  AND b.embedding IS NOT NULL;

COMMENT ON VIEW public.memory_duplicate_pairs IS
  'Near-duplicate memory pairs at cosine >= 0.92 (migration 065). 335 rows participate as of 2026-07-23. Rows appearing here are HELD BACK from auto-retirement so a thematic merge can preserve their content first.';

-- ─── 6. Retirement candidates — cold tier only, duplicates held back ─────────
CREATE OR REPLACE VIEW public.memory_retirement_candidates AS
WITH dup AS (
  SELECT id_a AS id FROM public.memory_duplicate_pairs
  UNION
  SELECT id_b FROM public.memory_duplicate_pairs
)
SELECT
  s.id, s.name, s.type, s.trust_tier, s.access_count,
  s.created_at, s.age_days, s.standing_value, s.staleness_candidate,
  (d.id IS NOT NULL) AS in_duplicate_cluster,
  CASE
    WHEN d.id IS NOT NULL THEN 'hold: consolidate cluster first'
    ELSE 'eligible: cold + never-accessed + aged'
  END AS disposition
FROM public.memory_standing s
LEFT JOIN dup d ON d.id = s.id
WHERE s.memory_tier = 'cold'
  AND s.access_count = 0
  AND s.created_at < now() - interval '90 days'
ORDER BY s.standing_value ASC;

COMMENT ON VIEW public.memory_retirement_candidates IS
  'Soft-retirement candidates (migration 065). Cold tier ONLY per AMV-L. Rows with in_duplicate_cluster = true are held back for consolidation and are NOT retired by retire_cold_memories().';

-- ─── 7. The retire verb — dry run by default, double-gated ───────────────────
CREATE TABLE IF NOT EXISTS public.memory_lifecycle_settings (
  key   text PRIMARY KEY,
  value boolean NOT NULL,
  notes text
);

INSERT INTO public.memory_lifecycle_settings(key, value, notes)
VALUES ('autoretire_enabled', false,
        'Master gate for retire_cold_memories(). Stays FALSE until Jeff approves batch 1 (2026-07-23 research rec 1).')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.retire_cold_memories(
  p_limit   integer DEFAULT 25,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE(id uuid, name text, standing_value double precision, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT value INTO v_enabled
  FROM public.memory_lifecycle_settings WHERE key = 'autoretire_enabled';

  -- Second gate: even an explicit p_dry_run := false is refused while the master
  -- setting is off. One flag alone can never cause a live retirement.
  IF NOT p_dry_run AND NOT COALESCE(v_enabled, false) THEN
    RAISE NOTICE 'retire_cold_memories: autoretire_enabled is false — forcing dry run.';
    p_dry_run := true;
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT c.id, c.name, c.standing_value
    FROM public.memory_retirement_candidates c
    WHERE c.in_duplicate_cluster = false
    ORDER BY c.standing_value ASC
    LIMIT p_limit
  ), done AS (
    UPDATE memories m
    SET is_active     = false,
        retired_at    = now(),
        retire_reason = 'lifecycle: cold tier, never accessed, aged >90d (migration 065)'
    FROM picked p
    WHERE m.id = p.id AND NOT p_dry_run
    RETURNING m.id
  )
  SELECT p.id, p.name, p.standing_value,
         CASE WHEN p_dry_run THEN 'DRY RUN: would retire' ELSE 'RETIRED (soft)' END
  FROM picked p;
END;
$$;

COMMENT ON FUNCTION public.retire_cold_memories IS
  'Soft-retires cold-tier memories by setting is_active=false (migration 065). NEVER deletes. Dry run by default AND gated on memory_lifecycle_settings.autoretire_enabled — both must be flipped for a live run. Reversible: set is_active=true, retired_at=NULL.';

-- ─── 8. Un-retire, because a reversible operation needs a documented reverse ──
CREATE OR REPLACE FUNCTION public.unretire_memory(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE memories
  SET is_active = true, retired_at = NULL, retire_reason = NULL
  WHERE id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.amac_standing_value(timestamptz, timestamptz, timestamptz, integer, double precision, double precision) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_memory_tiers() TO service_role;
GRANT EXECUTE ON FUNCTION public.retire_cold_memories(integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.unretire_memory(uuid) TO service_role;
GRANT SELECT ON public.memory_standing, public.memory_duplicate_pairs, public.memory_retirement_candidates TO service_role, authenticated;

COMMIT;
