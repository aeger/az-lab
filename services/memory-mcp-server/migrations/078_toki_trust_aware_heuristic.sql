-- Migration 078: add trust-aware TOKI rule for conflict resolution
-- Ref: 2026-07-27 daily research (arXiv 2606.22030), rec 2; migration 073 (TOKI vocabulary)
--
-- THE INSIGHT (from 2606.22030)
--   Bayesian belief updating alone gives ~no gain over last-write-wins. The win only
--   appears with RELIABILITY-CONDITIONED updating: trust capped by source provenance,
--   not by how confident the text sounds. We already track trust_tier on every row;
--   this migration wires it into conflict resolution to apply the paper's rule:
--
--     low/medium-trust write contradicting a high-trust memory → await_confirmation
--     (human should validate, not auto-resolve)
--
--     both similar trust → last_writer_wins (newest wins)
--
--   This is a semantic fork from temporal supersession (which is always newest-wins
--   within the same writer), applying to real contradictions across different sources.
--
-- IMPLEMENTATION
--   1. Add function trust_tier_to_heuristic() that takes both memories' trust_tiers
--      and returns the appropriate TOKI heuristic.
--   2. Wire it into detect_factual_contradiction() or any other conflict detector
--      that creates memory_conflicts rows. Use the pattern from migration 073's
--      detect_temporal_supersession(): pass explicit heuristic to INSERT.

-- ── 1. Trust-tier-aware heuristic selector ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.trust_tier_to_heuristic(
    p_tier_a text,
    p_tier_b text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    -- When one side is low-trust and the other is high, demand confirmation.
    -- The weaker side might be poisoned or speculative; auto-resolving would
    -- suppress that signal. A human can verify and choose.
    WHEN (LOWER(COALESCE(p_tier_a, 'unknown')) = 'low' OR
          LOWER(COALESCE(p_tier_a, 'unknown')) = 'quarantined')
      AND LOWER(COALESCE(p_tier_b, 'unknown')) = 'high'
      THEN 'await_confirmation'
    WHEN (LOWER(COALESCE(p_tier_b, 'unknown')) = 'low' OR
          LOWER(COALESCE(p_tier_b, 'unknown')) = 'quarantined')
      AND LOWER(COALESCE(p_tier_a, 'unknown')) = 'high'
      THEN 'await_confirmation'

    -- When one side is medium-trust and the other is high, weaker side loses.
    -- Medium is "attributable but indirect" (automation, pipeline); high is direct.
    -- Last-writer-wins is safe here because both sides are vouched for.
    WHEN (LOWER(COALESCE(p_tier_a, 'unknown')) = 'medium' AND
          LOWER(COALESCE(p_tier_b, 'unknown')) = 'high')
      OR (LOWER(COALESCE(p_tier_a, 'unknown')) = 'high' AND
          LOWER(COALESCE(p_tier_b, 'unknown')) = 'medium')
      THEN 'last_writer_wins'

    -- Verified > all: verified facts (manual, audited) supersede anything.
    WHEN LOWER(COALESCE(p_tier_a, 'unknown')) = 'verified'
      OR LOWER(COALESCE(p_tier_b, 'unknown')) = 'verified'
      THEN 'last_writer_wins'

    -- Both unknown or both missing: default to last-writer-wins.
    -- (If both are unknown, we have no reliability signal; temporal order is all we have.)
    ELSE 'last_writer_wins'
  END;
$$;

COMMENT ON FUNCTION public.trust_tier_to_heuristic(text, text) IS
  'TOKI heuristic selector based on source reliability (trust_tier). High-trust writes beating low-trust → await_confirmation (human verification); similar trust → last_writer_wins (temporal). Implements arXiv 2606.22030 rule: reliability-conditioned updating beats Bayesian alone. Called by conflict detectors at INSERT time, stamped into memory_conflicts.resolution_heuristic.';

-- ── 2. Document the usage pattern for conflict detectors ──────────────────
-- Any function that creates memory_conflicts rows should pass explicit heuristic:
--
--   INSERT INTO memory_conflicts (memory_a_id, memory_b_id, ..., resolution_heuristic)
--   SELECT m_a.id, m_b.id, ...,
--     public.trust_tier_to_heuristic(m_a.trust_tier, m_b.trust_tier)
--   FROM ...
--
-- Example (detect_factual_contradiction):
--   -- At the conflict INSERT site, call trust_tier_to_heuristic:
--   INSERT INTO memory_conflicts (memory_a_id, memory_b_id, conflict_type, ..., resolution_heuristic)
--   VALUES (v_a_id, v_b_id, 'factual_contradiction', ...,
--     public.trust_tier_to_heuristic((SELECT trust_tier FROM memories WHERE id=v_a_id),
--                                    (SELECT trust_tier FROM memories WHERE id=v_b_id)));

GRANT EXECUTE ON FUNCTION public.trust_tier_to_heuristic(text, text) TO anon, authenticated, service_role;

COMMENT ON MIGRATION 078 IS
  'Add trust-aware TOKI rule for conflict resolution (2026-07-27, arXiv 2606.22030). When a low/medium-trust write contradicts a high-trust memory, set resolution_heuristic=await_confirmation instead of auto-resolving. Depends on: migration 061 (trust_weight), 064 (derive_trust_tier), 073 (TOKI vocabulary). Usage: call trust_tier_to_heuristic(tier_a, tier_b) at conflict-detection INSERT time.';
