-- Migration 114: the fifth A-MAC term — outcome utility in retention scoring
--
-- WHY (audited live 2026-08-11, 1035 rows / 274 episodes):
--   The 2026-08-05 research run recommended "add access-count and outcome-weight
--   terms to the decay score, which is currently 80% similarity / 20% recency".
--   Half of that premise is stale and half of it is blocked. Verified live before
--   writing a line of this migration:
--
--   1. Decay scoring is NOT 80/20 similarity/recency. It has been the 4-term A-MAC
--      composite since migration 013, factored into amac_standing_value() by 065:
--        0.25*recency + 0.20*access_freq + 0.15*novelty + 0.25*importance, /0.85
--      So the recommended ACCESS-COUNT TERM ALREADY EXISTS at weight 0.20 and is
--      populated (466/1035 rows have access_count > 0, max 619, mean 33). Nothing
--      to add there. This is the same class of stale-baseline error the same
--      research run caught in its own CORRECTION v7 about the reranker.
--
--   2. The OUTCOME term was genuinely missing, and could not have been added,
--      because the signal it needs was never collected:
--        agent_episodes.memories_consulted  -> 0 of 274 episodes populated
--        memory_log.action                  -> create/update/delete only, no reads
--        record_task_completion             -> writes skills.success_count, and
--                                              skills have no FK to memories
--      The A-MAC weights summing to 0.85 and being divided by 0.85 is the fossil
--      of exactly this: the fifth term (utility) was specified, found unfittable,
--      and normalized away.
--
--   So the ordering had to be: collect the signal, THEN weight it. memory-mcp
--   v5.16.0 makes recall record what it served and record_episode default
--   memories_consulted to that set (see the consult-buffer block in src/index.ts).
--   This migration adds the term that consumes it.
--
-- WHY THE TERM IS A PURE BONUS AND NEVER A PENALTY:
--   amac_standing_value() feeds prune_decayed_memories(), which DELETEs rows, and
--   assign_memory_tiers(), which can route rows to the cold/retirement tier. A
--   scoring change on a destructive path is only safe if it is monotone in the
--   safe direction. So utility is added AFTER the /0.85 renormalization as a
--   strictly non-negative bonus in [0, 0.15]:
--       standing := (4-term composite)/0.85 + 0.15 * utility
--   utility >= 0 always, therefore every row's score is >= what it scores today.
--   Consequences, by construction rather than by testing:
--     - prune_decayed_memories can only ever delete a SUBSET of what it deletes now
--     - assign_memory_tiers can only ever move a row UP (toward hot), never toward cold
--   Episodes with status='failed' contribute 0, NOT a negative. A memory consulted
--   during a failed task is not thereby worthless — very often it is the memory
--   that diagnosed the failure — and a penalty would break the monotone guarantee
--   for no evidence-backed gain.
--
-- BLAST RADIUS AT DEPLOY: exactly zero rows change score. outcome_utility defaults
--   to 0.0 and no episode has ever populated memories_consulted, so the bonus term
--   is 0.0 for all 1035 rows on day one and the composite is bit-identical to
--   today's. The term goes live gradually as v5.16.0 accrues consult edges. That is
--   the intended shape: ship the weight inert, let the data arrive, and let the
--   nightly refresh move rows only once there is real evidence behind them.
--
-- DELIBERATELY NOT DONE: the PPO-learned policy weight from MEMTIER. Per the
--   research run's own recommendation, 1035 memories is nowhere near enough reward
--   signal to fit adaptive coefficients against, and it would be unfalsifiable.
--   Weights here stay hand-set and auditable.
--
-- COVERAGE CAVEAT ADDED 2026-08-15 (see migration 119 for the full reasoning):
--   This term samples WREN POLLER RUNS ONLY. Audited live on 2026-08-15: all 295
--   agent_episodes rows are agent=wren, because poll_queue.py is the only caller
--   of record_episode — Atlas and Iris have never opened an episode. Every
--   consult edge this migration's refresh consumes therefore comes from one
--   agent running short queue tasks. Fleet-wide episode opening was considered
--   and DECLINED: interactive surfaces have no deterministic session-close hook,
--   so it would mostly produce stranded traces for 117's reaper, which contribute
--   0 utility anyway. The monotone guarantee above still holds — under-coverage
--   costs a memory a bonus, never its life — but RELATIVE standing and tier
--   assignment do skew toward poller-adjacent memories. Read outcome_utility as
--   "the Wren poller found this useful", not as fleet utility.
--
-- ALSO FIXED HERE: prune_decayed_memories carried its own INLINE copy of the
--   composite (migration 013), which migration 065 called out as a copy-paste
--   hazard when it factored amac_standing_value() but did not convert this caller.
--   It now calls the function, so there is one definition to tune, not two.

BEGIN;

-- ─── Step 1: the utility column ──────────────────────────────────────────────
-- Materialized rather than computed on read: prune and tier assignment both scan
-- the whole table, and a correlated subquery over agent_episodes per row is
-- needless work for a value that only changes when an episode closes.
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS outcome_utility double precision NOT NULL DEFAULT 0.0;

COMMENT ON COLUMN memories.outcome_utility IS
  'A-MAC fifth term (migration 114). Saturating count of COMPLETED episodes that '
  'consulted this memory, normalized to [0,1]. Refreshed by '
  'refresh_memory_outcome_utility(). 0.0 = no outcome evidence, which scores '
  'identically to pre-114 behaviour.';
-- NOTE: migration 119 replaces this comment with a longer one carrying the
-- Wren-poller-only coverage caveat. 119 is the live text; this is the original.

-- memories_consulted is a uuid[]; the refresh unnests it and the ANY() lookups
-- want containment. GIN is the right index for both.
CREATE INDEX IF NOT EXISTS idx_agent_episodes_memories_consulted
  ON agent_episodes USING gin (memories_consulted);

-- ─── Step 2: derive utility from episode outcomes ────────────────────────────
-- LN(1+n)/LN(21) saturates at 20 successful consults, matching the shape the
-- access_freq term already uses (LN(1+n)/LN(101)) but with a lower ceiling:
-- a consult edge is a much stronger and much rarer signal than a bare read, so
-- it should reach full weight far sooner.
CREATE OR REPLACE FUNCTION public.refresh_memory_outcome_utility()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE updated_count integer;
BEGIN
  WITH consult_counts AS (
    SELECT c.memory_id, count(*) AS n
    FROM agent_episodes e
    CROSS JOIN LATERAL unnest(e.memories_consulted) AS c(memory_id)
    WHERE e.status = 'completed'
      AND e.memories_consulted IS NOT NULL
    GROUP BY c.memory_id
  ), scored AS (
    SELECT m.id,
           -- COALESCE the COUNT, not the LEAST() result. Postgres LEAST/GREATEST
           -- IGNORE NULL arguments instead of propagating them, so the obvious
           -- COALESCE(LEAST(LN(1.0 + cc.n...), 1.0), 0.0) silently returns 1.0 for
           -- every row the LEFT JOIN missed — i.e. full utility on zero evidence.
           -- That bug shipped and was repaired by migration 114a; this file carries
           -- the corrected form so a fresh replay is right the first time.
           -- n = 0 -> LN(1)/LN(21) = 0 naturally, so no outer COALESCE is needed.
           LEAST(LN(1.0 + COALESCE(cc.n, 0)::float) / LN(21.0), 1.0) AS util
    FROM memories m
    LEFT JOIN consult_counts cc ON cc.memory_id = m.id
  )
  UPDATE memories m
  SET outcome_utility = s.util
  FROM scored s
  WHERE m.id = s.id
    AND m.outcome_utility IS DISTINCT FROM s.util;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

-- ─── Step 3: the composite gains its fifth term ──────────────────────────────
-- The 6-arg version must be dropped, not replaced: adding a defaulted parameter
-- creates a NEW signature, and leaving both live makes every 6-arg call ambiguous.
-- That is precisely the overload hazard migration 045 had to clean up. Both
-- dependent views are dropped and recreated verbatim rather than CASCADEd blind —
-- memory_retirement_candidates reads standing_value from memory_standing, so it
-- picks up the new term without any change to its own logic.
DROP VIEW IF EXISTS public.memory_retirement_candidates;
DROP VIEW IF EXISTS public.memory_standing;
DROP FUNCTION IF EXISTS public.amac_standing_value(
  timestamp with time zone, timestamp with time zone, timestamp with time zone,
  integer, double precision, double precision);

CREATE FUNCTION public.amac_standing_value(
  p_last_accessed_at timestamp with time zone,
  p_updated_at       timestamp with time zone,
  p_created_at       timestamp with time zone,
  p_access_count     integer,
  p_novelty          double precision,
  p_importance       double precision,
  p_utility          double precision DEFAULT 0.0
) RETURNS double precision
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $function$
  -- p_updated_at is accepted for signature stability but DELIBERATELY IGNORED.
  -- See migration 067: it is trigger-mutated and therefore not a freshness signal.
  SELECT (
      0.25 * EXP(-0.1 * GREATEST(
               EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed_at, p_created_at))) / 86400.0, 0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(p_novelty, 0.5)
    + 0.25 * COALESCE(p_importance, 0.5)
  ) / 0.85
  -- Migration 114: fifth term, applied OUTSIDE the /0.85 renormalization so it is
  -- a strictly non-negative bonus. p_utility defaults to 0.0, so a caller that has
  -- not been taught about outcomes gets exactly the pre-114 value.
  + 0.15 * GREATEST(COALESCE(p_utility, 0.0), 0.0)
$function$;

COMMENT ON FUNCTION public.amac_standing_value IS
  'Query-independent A-MAC standing value. 4-term composite renormalized to 1.0, '
  'plus a non-negative outcome-utility bonus in [0,0.15] (migration 114). Monotone: '
  'the bonus can only raise a score, so it can never cause a new prune or a '
  'demotion to cold.';

-- ─── Step 4: teach the three call sites to pass utility ──────────────────────
CREATE VIEW public.memory_standing AS
 SELECT id,
    name,
    type,
    memory_class,
    trust_tier,
    memory_tier,
    COALESCE(access_count, 0) AS access_count,
    created_at,
    verified_at,
    staleness_candidate,
    EXTRACT(day FROM now() - created_at)::integer AS age_days,
    outcome_utility,
    amac_standing_value(last_accessed_at, updated_at, created_at, access_count,
                        amac_novelty_score, importance_score, outcome_utility) AS standing_value
   FROM memories m
  WHERE COALESCE(is_active, true) IS NOT FALSE;

GRANT SELECT ON public.memory_standing TO anon, authenticated, service_role;

-- Recreated verbatim from the pre-114 definition.
CREATE VIEW public.memory_retirement_candidates AS
 WITH dup AS (
         SELECT memory_duplicate_pairs.id_a AS id
           FROM memory_duplicate_pairs
        UNION
         SELECT memory_duplicate_pairs.id_b
           FROM memory_duplicate_pairs
        )
 SELECT s.id, s.name, s.type, s.trust_tier, s.access_count, s.created_at,
    s.age_days, s.standing_value, s.staleness_candidate,
    d.id IS NOT NULL AS in_duplicate_cluster,
        CASE
            WHEN d.id IS NOT NULL THEN 'hold: consolidate cluster first'::text
            ELSE 'eligible: cold + never-accessed + aged'::text
        END AS disposition
   FROM memory_standing s
     LEFT JOIN dup d ON d.id = s.id
  WHERE s.memory_tier = 'cold'::text AND s.access_count = 0
    AND s.created_at < (now() - '90 days'::interval)
  ORDER BY s.standing_value;

GRANT SELECT ON public.memory_retirement_candidates TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_memory_tiers()
RETURNS TABLE(tier text, n bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  WITH scored AS (
    SELECT m.id,
      public.amac_standing_value(
        m.last_accessed_at, m.updated_at, m.created_at,
        m.access_count, m.amac_novelty_score, m.importance_score,
        m.outcome_utility) AS sv,
      COALESCE(m.access_count, 0) AS ac,
      m.created_at, m.type, m.memory_class, m.lifecycle_pinned
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
  ), assigned AS (
    SELECT id,
      CASE
        WHEN sv >= 0.60 OR ac >= 10 THEN 'hot'
        WHEN sv < 0.45 AND ac = 0
             AND created_at < now() - interval '60 days'
             AND type NOT IN ('user', 'feedback')          -- guard 1
             AND COALESCE(memory_class, '') <> 'procedural' -- guard 2
             AND NOT lifecycle_pinned                       -- guard 3
          THEN 'cold'
        ELSE 'warm'
      END AS new_tier
    FROM scored
  )
  UPDATE memories m
  SET memory_tier = a.new_tier, tier_assigned_at = now()
  FROM assigned a
  WHERE m.id = a.id
    AND (m.memory_tier IS DISTINCT FROM a.new_tier OR m.tier_assigned_at IS NULL);

  RETURN QUERY
    SELECT m.memory_tier, count(*)
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
    GROUP BY m.memory_tier ORDER BY 1;
END;
$function$;

-- prune_decayed_memories: inline composite (migration 013) replaced by the shared
-- function. Behaviour is unchanged for outcome_utility = 0.0, which is every row today.
CREATE OR REPLACE FUNCTION public.prune_decayed_memories(
  min_age_days integer DEFAULT 30,
  min_amac_threshold double precision DEFAULT 0.20)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM memories m
  WHERE m.updated_at < now() - (min_age_days || ' days')::interval
    AND public.amac_standing_value(
          m.last_accessed_at, m.updated_at, m.created_at,
          m.access_count, m.amac_novelty_score, m.importance_score,
          m.outcome_utility) < min_amac_threshold;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.prune_decayed_memories TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_memory_outcome_utility TO service_role;
GRANT EXECUTE ON FUNCTION public.amac_standing_value TO anon, authenticated, service_role;

-- ─── Step 5: seed the column from whatever history exists ────────────────────
-- Expected to update 0 rows today (memories_consulted is empty across all 274
-- episodes). Run for correctness, and so the migration is idempotent if episodes
-- accrue before it is applied elsewhere.
SELECT public.refresh_memory_outcome_utility();

COMMIT;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Monotone guarantee — must return 0 rows (no score may DROP vs the 4-term base):
--   SELECT count(*) FROM memories m
--   WHERE amac_standing_value(m.last_accessed_at, m.updated_at, m.created_at,
--           m.access_count, m.amac_novelty_score, m.importance_score, m.outcome_utility)
--       < amac_standing_value(m.last_accessed_at, m.updated_at, m.created_at,
--           m.access_count, m.amac_novelty_score, m.importance_score, 0.0);
--
-- Consult-edge accrual (should climb from 0 once v5.16.0 is deployed):
--   SELECT count(*) FILTER (WHERE memories_consulted IS NOT NULL
--                             AND array_length(memories_consulted,1) > 0) AS with_consulted,
--          count(*) AS episodes FROM agent_episodes;
--   SELECT count(*) FILTER (WHERE outcome_utility > 0) AS with_utility FROM memories;
--
-- Dry-run the prune before trusting it (threshold 0 = count only, deletes nothing
-- at the default 0.20 gate since scores are strictly positive):
--   SELECT count(*) FROM memories m
--   WHERE m.updated_at < now() - interval '30 days'
--     AND amac_standing_value(m.last_accessed_at, m.updated_at, m.created_at,
--           m.access_count, m.amac_novelty_score, m.importance_score,
--           m.outcome_utility) < 0.20;
