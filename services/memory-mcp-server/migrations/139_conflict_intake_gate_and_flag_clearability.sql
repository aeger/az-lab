-- 139_conflict_intake_gate_and_flag_clearability.sql — 2026-08-28
--
-- Jeff authorised fix #2 (the x0.75 policy) and fix #3 (detector thresholds) on the
-- 2026-08-26 "unblock the conflict sweep" task, after 137/138 landed fix #1 and #4.
-- This migration is those two, plus one NEW bug found while measuring them.
--
-- ============================================================================
-- MEASURED 2026-08-28, before any change
-- ============================================================================
--   open conflicts 396 · pit_deferred 359 (90.7%) · adjudicable 37 · oldest open 2026-08-12
--
--   conflict_block_report(500) — what resolve_conflict_auto() would do to all 396:
--     359  skipped   "point-in-time record cannot be superseded by a later fact"
--      16  closed_no_longer_stale
--      10  vetoed_forget_guard            (permanent residue, human call)
--       5  skipped   "winner is itself superseded"  (permanent residue, human call)
--       3  closed_already_superseded
--       3  stale_repaired
--
--   Where the 396 come from — the SQL scan is NOT the producer:
--     2026-08-28 03:30 scan summary: new_contradictions 0, new_stale 0.
--     Open went 310 -> 410 in the 24h between the 08-27 and 08-28 scans anyway.
--     ALL of that intake is detectConflicts() on the memory-write path in src/index.ts,
--     detected_by='negation_heuristic' / 'sim_threshold_0.85'.
--
--   PIT-ness of the 347 open negation_heuristic contradictions, by side:
--     both sides point-in-time      290
--     new side only                  13
--     candidate side only            29
--     neither                        15
--   Sampled pairs (8 random both-PIT): every one is a dated log series arguing
--   with itself — "AI Memory Research - 2026-08-28" vs "... - 2026-08-27",
--   "State of Lab — 2026-08-27" vs "... — 2026-08-23", "Dreaming summary
--   2026-08-27" vs "... 2026-08-25". The negation patterns include \bupdated?\b
--   and \bchanged?\b and the topic bar is `overlap >= 3` absolute words of >=4
--   chars, so any two long research digests trip it.
--
--   Detector yield, whole lifetime: 823 negation_heuristic rows since 2026-08-23.
--   ZERO produced a supersession. 328 of the 494 it ever closed were closed with
--   "neither side is superseded/expired any more; stale flag no longer applies" —
--   i.e. the detector's own claim, withdrawn by the resolver.
--
-- ============================================================================
-- FIX #3 — the detector's threshold, expressed as an invariant instead of a number
-- ============================================================================
--   Migration 133 already ruled that resolve_conflict_auto() must NEVER adjudicate a
--   conflict touching an is_point_in_time row: a dated record was true as of its date
--   and cannot be superseded by a later fact. 137 then removed those rows from the
--   sweep's candidate set. Detection never got the memo, so the write path keeps
--   FILING rows that, by construction, no code path can ever close.
--
--   So the gate here is not a tuned threshold — it is detection agreeing with
--   resolution. One predicate, already written once in conflict_sweep_queue.pit_deferred:
--       conflict_type <> 'stale' AND (either side is_point_in_time)
--   conflict_type='stale' is deliberately still allowed through: that arm is CASE A
--   in the resolver, never reaches the 133 guard, and 411 of them have been
--   adjudicated successfully.
--
--   Enforced as a BEFORE INSERT trigger on memory_conflicts rather than only in
--   TypeScript, because there are two producers (src/index.ts detectConflicts and
--   scan_memory_contradictions) and a third can be added by anyone with SQL access.
--
-- ============================================================================
-- FIX #2 — the x0.75 that cannot be cleared
-- ============================================================================
--   governance_weight() (063) multiplies 0.75 into any conflict_flagged row.
--   resolve_conflict() (086) clears the flag when a memory's LAST open conflict
--   closes. A PIT conflict never closes, so the flag never clears.
--   MEASURED: 163 memories carry the flag. 120 of them have open conflicts that
--   are ALL pit_deferred — a permanent 25% recall penalty on 120 rows for a
--   contradiction the system has decided it will never adjudicate. 1 more carries
--   a leaked flag with every conflict already closed (086's one-shot backfill was
--   one-shot; the leak recurred).
--
--   Fix: close the unadjudicable backlog with an HONEST disposition rather than
--   pretending it was judged, then clear the flags that closure orphans, then keep
--   clearing them every sweep instead of once.
--   Reversible in one statement:
--       UPDATE memory_conflicts SET resolved=false, resolved_at=NULL, resolved_by=NULL,
--              resolution_notes=NULL
--       WHERE resolved_by='migration-139-pit-not-adjudicable';
--
--   resolution_heuristic is deliberately NOT used to tag these. It is CHECK-constrained
--   to the trust-tier adjudication heuristics (last_writer_wins / evidence_weighted_merge
--   / await_confirmation / per_rule_policy) and means "how a winner was picked". No
--   winner was picked here, so widening that enum would corrupt its meaning. The tag
--   lives in resolved_by, which is free text.
--
-- ============================================================================
-- NEW BUG (found while measuring the above) — adjudicated conflicts resurrect
-- ============================================================================
--   detectConflicts() upserts with onConflict:"memory_a_id,memory_b_id" and a
--   literal `resolved: false` in the payload. PostgREST turns that into
--   ON CONFLICT DO UPDATE, so re-writing a memory pair that was ALREADY adjudicated
--   flips its conflict row back to open — and re-flags conflict_flagged on both
--   memories, undoing exactly the clear migration 086 exists to perform.
--
--   PROBE: a resurrected row keeps the old resolved_at/resolved_by while resolved
--   reads false. 8 such rows exist right now, all detected_by='negation_heuristic',
--   all created 2026-08-26 05:20, all stamped resolved_at 2026-08-28 03:30:11 by
--   this morning's sweep and reopened by memory writes since. The sweep re-does
--   that adjudication every night, forever, and `adjudicated` counts it as work.
--
--   Fix: a BEFORE UPDATE guard. A detector may not un-adjudicate a conflict.
--   Deliberate reopens set azlab.allow_conflict_reopen first.
--
-- No memory content is modified. No supersession is created. No memory is retired.
-- ============================================================================

BEGIN;

-- ── 1. Intake gate + resurrection guard ─────────────────────────────────────
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
    -- A detector upsert must not un-adjudicate a closed conflict (see NEW BUG above).
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

  -- INSERT: suppress conflicts the resolver refuses by design and never closes.
  -- Predicate is conflict_sweep_queue.pit_deferred, verbatim.
  IF NEW.conflict_type IS DISTINCT FROM 'stale' THEN
    SELECT bool_or(COALESCE(m.is_point_in_time, false)) INTO v_pit
    FROM memories m WHERE m.id IN (NEW.memory_a_id, NEW.memory_b_id);
    IF COALESCE(v_pit, false) THEN
      RETURN NULL;  -- row is not written; the caller's upsert is a no-op
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.conflict_intake_gate() IS
  'BEFORE INSERT: drops a conflict touching an is_point_in_time row unless conflict_type=''stale'' — the same predicate conflict_sweep_queue.pit_deferred uses, so detection can no longer file rows resolve_conflict_auto() refuses forever (migrations 133/137). BEFORE UPDATE: restores resolved/resolved_at/resolved_by when something tries to flip a closed conflict back open, which is what detectConflicts''s upsert payload did. Set azlab.allow_conflict_reopen=''on'' in-transaction for a deliberate reopen. Migration 139.';

DROP TRIGGER IF EXISTS conflict_intake_gate_bi ON public.memory_conflicts;
CREATE TRIGGER conflict_intake_gate_bi
  BEFORE INSERT ON public.memory_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.conflict_intake_gate();

DROP TRIGGER IF EXISTS conflict_no_resurrect_bu ON public.memory_conflicts;
CREATE TRIGGER conflict_no_resurrect_bu
  BEFORE UPDATE ON public.memory_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.conflict_intake_gate();

-- ── 2. Flag clearability, as a repeating pass rather than a one-shot ────────
CREATE OR REPLACE FUNCTION public.clear_orphan_conflict_flags()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_cleared integer;
BEGIN
  WITH cleared AS (
    UPDATE memories m SET conflict_flagged = false
    WHERE COALESCE(m.conflict_flagged, false)
      -- The mem0 tentative-write path sets conflict_flagged deliberately and
      -- carries the state in provenance, not in a conflict row. Leave it standing.
      AND COALESCE(m.provenance->>'tentative', 'false') <> 'true'
      -- Covers the orphan case too: scan_memory_contradictions' `flag` CTE reads
      -- from `candidates`, not from `ins`, so it can flag a memory whose conflict
      -- row was never written (ON CONFLICT DO NOTHING, or the intake gate above).
      AND NOT EXISTS (SELECT 1 FROM memory_conflicts c
                      WHERE COALESCE(c.resolved, false) = false
                        AND (c.memory_a_id = m.id OR c.memory_b_id = m.id))
    RETURNING 1)
  SELECT count(*) INTO v_cleared FROM cleared;
  RETURN v_cleared;
END;
$$;

COMMENT ON FUNCTION public.clear_orphan_conflict_flags() IS
  'Clears conflict_flagged on memories with no OPEN conflict, so governance_weight() stops applying x0.75 to them. Migration 086 did this once as a backfill and wired the per-conflict case into resolve_conflict(); neither covers a conflict closed by any other route, nor a flag whose conflict row was never written, and the leak recurred. Skips rows the mem0 tentative-write path flagged on purpose (provenance.tentative). Called at the end of every sweep_conflicts() run. Migration 139.';

REVOKE EXECUTE ON FUNCTION public.clear_orphan_conflict_flags() FROM anon, authenticated;

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
-- 3a. Repair the rows the resurrection bug reopened. They were genuinely
--     adjudicated; the resolution_notes/resolved_at on them are the real ones.
UPDATE memory_conflicts SET resolved = true
WHERE NOT COALESCE(resolved, false) AND resolved_at IS NOT NULL;

-- 3b. Close the unadjudicable point-in-time backlog. NOT "resolved" in the sense of
--     judged — the disposition is recorded as what it is, and every row stays in
--     memory_conflicts for audit, queryable by resolved_by.
UPDATE memory_conflicts c SET
    resolved             = true,
    resolved_at          = now(),
    resolved_by          = 'migration-139-pit-not-adjudicable',
    resolution_notes     = 'closed unadjudicated: a side is an immutable point-in-time '
                           'record, so resolve_conflict_auto() refuses it by design '
                           '(migration 133) and no path could ever close it. No winner '
                           'picked, no memory modified, no supersession created. '
                           'resolution_heuristic stays NULL on purpose — no heuristic ran. '
                           'Reversible: WHERE resolved_by=''migration-139-pit-not-adjudicable''.'
FROM public.conflict_sweep_queue q
WHERE q.id = c.id AND q.pit_deferred;

-- 3c. Drop the x0.75 the closure orphans.
SELECT public.clear_orphan_conflict_flags();

-- ── 4. Wire the clear into the nightly sweep ────────────────────────────────
CREATE OR REPLACE FUNCTION public.sweep_conflicts(
  p_limit integer DEFAULT 200,
  p_actor text    DEFAULT 'conflict-sweep',
  p_types text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r             RECORD;
  v_res         jsonb;
  v_actions     jsonb := '{}'::jsonb;
  v_action      text;
  v_total       integer := 0;
  v_errors      integer := 0;
  v_skipped     integer := 0;
  v_vetoed      integer := 0;
  v_open_before integer;
  v_open_after  integer;
  v_available   integer;
  v_deferred    integer;
  v_unflagged   integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE NOT q.pit_deferred
                            AND (p_types IS NULL OR q.conflict_type = ANY(p_types))),
         count(*) FILTER (WHERE q.pit_deferred)
    INTO v_open_before, v_available, v_deferred
  FROM public.conflict_sweep_queue q;

  FOR r IN
    -- Candidates the resolver can actually act on (migration 137). As of 139 the
    -- intake gate stops most pit_deferred rows being filed at all, but the filter
    -- stays: it is the only thing that holds if the gate is ever dropped.
    SELECT q.id FROM public.conflict_sweep_queue q
    WHERE NOT q.pit_deferred
      AND (p_types IS NULL OR q.conflict_type = ANY(p_types))
    ORDER BY q.created_at ASC
    LIMIT p_limit
  LOOP
    BEGIN
      v_res := public.resolve_conflict_auto(r.id, p_actor);
      v_action := v_res->>'action';
    EXCEPTION
      WHEN SQLSTATE 'GV001' THEN
        -- memories_forget_guard refused to retire the loser (migration 138).
        -- A standing governance decision, not a fault: do not inflate `errors`
        -- with it, and do not resolve the conflict -- it needs a human.
        v_vetoed := v_vetoed + 1;
        v_action := 'vetoed_forget_guard';
      WHEN OTHERS THEN
        -- One bad row must not abort the sweep.
        v_errors := v_errors + 1;
        v_action := 'error';
    END;
    IF v_action = 'skipped' THEN
      v_skipped := v_skipped + 1;
    END IF;
    v_total := v_total + 1;
    v_actions := jsonb_set(v_actions, ARRAY[v_action],
                           to_jsonb(COALESCE((v_actions->>v_action)::integer, 0) + 1));
  END LOOP;

  -- Migration 139: a conflict closed by any route must drop the x0.75 with it.
  v_unflagged := public.clear_orphan_conflict_flags();

  SELECT count(*) INTO v_open_after FROM public.conflict_sweep_queue;

  INSERT INTO public.conflict_sweep_runs (
    actor, sweep_limit, open_before, candidates_available, pit_deferred,
    processed, adjudicated, skipped, vetoed, errors, actions, open_after)
  VALUES (p_actor, p_limit, v_open_before, v_available, v_deferred,
          v_total, v_total - v_skipped - v_vetoed - v_errors,
          v_skipped, v_vetoed, v_errors,
          v_actions || jsonb_build_object('flags_cleared', v_unflagged), v_open_after);

  RETURN jsonb_build_object(
    'processed', v_total,
    'adjudicated', v_total - v_skipped - v_vetoed - v_errors,
    'skipped', v_skipped,
    'vetoed_forget_guard', v_vetoed,
    'errors', v_errors,
    'actions', v_actions,
    'conflict_flags_cleared', v_unflagged,
    'candidates_available', v_available,
    'pit_deferred_not_selected', v_deferred,
    'open_conflicts_remaining', v_open_after);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sweep_conflicts(integer, text, text[]) FROM anon, authenticated;

COMMIT;
