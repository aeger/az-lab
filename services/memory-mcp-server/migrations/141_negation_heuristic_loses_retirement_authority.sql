-- 141_negation_heuristic_loses_retirement_authority.sql — 2026-08-28
--
-- WHY, MEASURED THE SAME HOUR 139/140 LANDED
--   139 gated the point-in-time case, which was 95.7% of the negation heuristic's
--   volume. Writing ONE memory afterwards — the note describing 139 itself — filed
--   4 fresh contradiction rows against non-PIT rows:
--       conflict-intake-gate-is-the-choke-point-migration-139  vs
--         conflict-sweep-candidate-set-excludes-pit-migration-137
--         forget-guard-veto-is-silent-supersede-memory-could-not-see-it
--         state-of-lab-was-never-classified-as-a-dated-series
--         mem0-has-no-retire-path-conflict-gate
--   All 4 are complementary notes about the same subsystem. None is a rival claim.
--   TWO of the four losers had been restored by migration 140 nine minutes earlier;
--   the next sweep would have retired them again.
--
--   Lifetime precision of this detector on the only decision that costs anything:
--   823 conflict rows since 2026-08-23 -> 54 supersessions -> 2 correct (both
--   same-stem dated series). ~4%. The other 52 retired live, still-true notes,
--   including migration 138's own finding one day after it was written. Ten more
--   are alive only because memories_forget_guard happens to protect eval golds.
--
-- WHAT CHANGES — AUTHORITY, NOT SENSITIVITY
--   No threshold is retuned; retuning a bar of ">= 3 overlapping words of >= 4 chars
--   plus one negation token from a list containing \bupdated?\b" has no defensible
--   number to move it to, and picking one would be a guess dressed as a fix.
--
--   Instead the detector loses the power to retire. It files TWO rows per pair:
--     * conflict_type='contradiction' — routes to resolve_conflict_auto's CASE B,
--       picks a winner by max(version, content_timestamp) and calls supersede_memory().
--       This is the arm with 4% precision and the whole blast radius. It is now
--       refused at intake.
--     * conflict_type='stale' — routes to CASE A, which NEVER invents a supersession;
--       it re-points citations and de-weights the stale edge, and closes itself with
--       "neither side is superseded/expired any more" when the claim does not hold.
--       411 of these have resolved cleanly. It is kept, and it carries the advisory
--       signal (description + conflict_flagged, which now clears when it closes).
--
--   So a weak-evidence detector still SURFACES a suspicion and still demotes both
--   rows while the suspicion is open. It can no longer act on one. Detectors with
--   real evidence (contradiction-scan's cross-agent embedding divergence at
--   sim >= 0.88 with a 7-day content gap) are untouched.
--
-- Also closes the 4 rows the probe write just created.
-- Reversible: drop the second condition from conflict_intake_gate().

BEGIN;

CREATE OR REPLACE FUNCTION public.conflict_intake_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pit boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A detector upsert must not un-adjudicate a closed conflict (migration 139).
    IF COALESCE(OLD.resolved, false) AND NOT COALESCE(NEW.resolved, false)
       AND COALESCE(current_setting('azlab.allow_conflict_reopen', true), 'off') <> 'on'
    THEN
      NEW.resolved            := OLD.resolved;
      NEW.resolved_at         := OLD.resolved_at;
      NEW.resolved_by         := OLD.resolved_by;
      NEW.resolution_notes    := OLD.resolution_notes;
      NEW.resolution_heuristic := OLD.resolution_heuristic;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT gate 1 (139): conflicts the resolver refuses by design and never closes.
  -- Predicate is conflict_sweep_queue.pit_deferred, verbatim.
  IF NEW.conflict_type IS DISTINCT FROM 'stale' THEN
    SELECT bool_or(COALESCE(m.is_point_in_time, false)) INTO v_pit
    FROM memories m WHERE m.id IN (NEW.memory_a_id, NEW.memory_b_id);
    IF COALESCE(v_pit, false) THEN
      RETURN NULL;
    END IF;
  END IF;

  -- INSERT gate 2 (141): the negation heuristic may not open a RETIREMENT decision.
  -- Its 'contradiction' rows route to resolve_conflict_auto's supersede path and
  -- scored 2 correct of 54 there. Its 'stale' rows never retire anything and are
  -- still admitted, so the advisory signal survives without the authority.
  IF NEW.detected_by = 'negation_heuristic'
     AND NEW.conflict_type = 'contradiction' THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.conflict_intake_gate() IS
  'BEFORE INSERT, two refusals. (139) a conflict touching an is_point_in_time row unless conflict_type=''stale'' — the conflict_sweep_queue.pit_deferred predicate, so detection agrees with the resolver''s standing refusal (133/137). (141) any detected_by=''negation_heuristic'' conflict_type=''contradiction'' — that arm routes to supersede_memory() and measured 2 correct retirements out of 54; its ''stale'' twin carries the same suspicion without the authority and is still admitted. BEFORE UPDATE: restores resolved/resolved_at/resolved_by when something tries to flip a closed conflict back open, which is what detectConflicts''s upsert payload did. Set azlab.allow_conflict_reopen=''on'' in-transaction for a deliberate reopen.';

-- Close the 4 rows the post-139 probe write filed before this gate existed.
UPDATE memory_conflicts SET
    resolved         = true,
    resolved_at      = now(),
    resolved_by      = 'migration-141-weak-evidence',
    resolution_notes = 'closed unadjudicated: filed by the negation heuristic, whose '
                       'contradiction arm scored 2 correct retirements in 54 and is '
                       'refused at intake as of migration 141. No winner picked, no '
                       'memory modified. The paired conflict_type=''stale'' row carries '
                       'the same suspicion and is still open.'
WHERE NOT COALESCE(resolved, false)
  AND detected_by = 'negation_heuristic'
  AND conflict_type = 'contradiction';

SELECT public.clear_orphan_conflict_flags();

COMMIT;
