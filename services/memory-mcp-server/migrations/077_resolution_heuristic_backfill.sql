-- Migration 077: backfill resolution_heuristic to last_writer_wins for existing conflicts
-- Ref: 2026-07-27 daily research, rec 2; migration 073 (added resolution_heuristic column)
--
-- THE PROBLEM
--   Migration 073 added resolution_heuristic column and TOKI vocabulary to memory_conflicts.
--   But only NEW temporal_supersession conflicts detected during that migration run were
--   labeled. 359 pre-existing conflicts (semantic/factual/other types) have NULL heuristics.
--   This makes the audit trail incomplete and blocks downstream trust-aware logic that
--   needs to know HOW each conflict was resolved (not just THAT it was resolved).
--
-- THE FIX
--   Backfill all NULL heuristics with 'last_writer_wins' as the default. This is the
--   historical implicit behavior (newest/most-recent fact wins). After backfill, every
--   conflict row documents its resolving heuristic, and the heuristic can be used in
--   recall and ranking logic.
--
-- POST-BACKFILL NEXT STEP
--   Migration 078 will add the trust-aware TOKI rule: when a low/medium-trust write
--   contradicts a high-trust memory, set resolution_heuristic='await_confirmation'
--   instead of 'last_writer_wins'. This backfill clears the NULL state so all rows
--   carry a label, and all NEW detections can use the smarter rule.

DO $backfill$
DECLARE
  v_before integer;
  v_after  integer;
BEGIN
  SELECT COUNT(*) INTO v_before
  FROM memory_conflicts
  WHERE resolution_heuristic IS NULL;

  UPDATE memory_conflicts
  SET resolution_heuristic = 'last_writer_wins'
  WHERE resolution_heuristic IS NULL;

  SELECT COUNT(*) INTO v_after
  FROM memory_conflicts
  WHERE resolution_heuristic IS NULL;

  RAISE NOTICE 'migration 077: backfilled % conflicts to last_writer_wins (% remaining NULL)',
    (v_before - v_after), v_after;
END
$backfill$;

-- MIGRATION 077 NOTE:
-- Backfill resolution_heuristic=last_writer_wins for all conflicts with NULL heuristics (2026-
-- 07-27). Clears the audit trail gap left by migration 073; every conflict now documents its r
-- esolving heuristic. Next: migration 078 adds trust-aware TOKI rule.
