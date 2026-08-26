-- 138_supersede_memory_veto_blindness.sql — 2026-08-26
--
-- Follow-up to 137. With the point-in-time head-of-line blockers out of the
-- candidate set, the sweep's remaining budget went to 25 reachable conflicts —
-- and 12 of them died with the SAME opaque error, every night since 2026-08-12:
--
--   ERROR 23514: supersedes edge has no matching memories.superseded_by
--   DETAIL: attempted 9c6894a4… -> 367a54d5…, but memories.superseded_by for
--           the source is NULL
--   CONTEXT: enforce_supersedes_edge_direction()  (migration 105)
--            <- supersede_memory() line 47
--            <- resolve_conflict_auto() line 145
--
-- WHAT IS ACTUALLY WRONG (measured 2026-08-26, dry-run probe over all 25)
--   supersede_memory() opens with
--       UPDATE memories SET superseded_by = p_new_id, is_active = false … WHERE id = p_old_id;
--   That UPDATE fires memories_forget_guard (BEFORE UPDATE, WHEN is_active
--   changes) -> guard_memory_forgetting(). With forget_guard_settings.guard_mode
--   = 'veto' (its live value) the guard REFUSES the row by RETURN NULL: the row
--   is skipped, the rest of the statement commits, and the caller is told
--   nothing. UPDATE reports 0 rows and supersede_memory never looks.
--
--   It then carries on as if the retire had happened:
--     line ~30  rewires inbound links onto the winner
--     line ~40  downweights every inbound edge of the "loser" to 0.05
--     line ~47  inserts the loser->winner 'supersedes' edge
--   Only that last statement fails, because migration 105 checks the edge
--   against memories.superseded_by — which is still NULL, because the retire
--   was vetoed. Migration 105 is not the bug. It is the only reason this was
--   ever visible: it is the sole thing standing between a vetoed supersession
--   and a committed one that rewired and 0.05'd the links of a row that is
--   still active. The error is a backstop firing three statements too late.
--
--   All 12 losers are vetoed for reason (i): positive gold in an ACTIVE eval
--   probe. Retiring one would depress recall@5 on the next nightly and read as
--   a ranker regression — the guard is right to refuse. The defect is that
--   supersede_memory cannot tell "refused" from "done".
--
-- WHAT THIS MIGRATION CHANGES
--   1. supersede_memory() verifies its own UPDATE landed, and if the guard
--      vetoed it, raises SQLSTATE 'GV001' IMMEDIATELY — before the rewire and
--      before the downweight. No partial lineage work on a row that was never
--      retired. Today that partial work is undone only because the 105 trigger
--      happens to abort the statement; this makes it structural.
--   2. sweep_conflicts() classifies 'GV001' as action='vetoed_forget_guard'
--      instead of a nameless 'error', and counts it separately. A governance
--      veto is a decision, not a fault, and 12 nightly "errors" that are really
--      "a human must choose" is how a queue rots quietly.
--   3. conflict_block_report() — a DRY RUN over the open queue that reports what
--      resolve_conflict_auto() would actually do to each conflict, by CALLING
--      the real resolver inside a savepoint it always rolls back. No duplicated
--      winner logic, so it cannot drift from the resolver the way a hand-written
--      predicate would.
--
-- NOT IN SCOPE, deliberately: the x0.75 governance weight on conflict_flagged
-- rows, and the detector thresholds. No conflict_flagged value is touched, no
-- conflict is marked resolved, no memory row is modified by this migration.
--
-- Idempotent.

-- ── 1. supersede_memory: notice when the forget-guard refuses ────────────────
-- Patches the LIVE definition rather than restating it, so unrelated drift
-- (115's downweight, 108's valid_to) cannot be silently reverted. Raises if the
-- anchor has moved.
DO $mig138$
DECLARE
  v_def    text;
  v_new    text;
  -- The statement immediately AFTER the retire UPDATE. The check must land
  -- between them: before any link is rewired or downweighted.
  v_anchor text := '  WITH inbound AS (';
  v_check  text := $chk$  -- ── VETO CHECK (migration 138, 2026-08-26) ──────────────────────────────────
  -- memories_forget_guard is a BEFORE UPDATE trigger that, in guard_mode='veto',
  -- refuses a row by RETURN NULL: the UPDATE above silently affects 0 rows and
  -- superseded_by stays NULL. Everything below this point (rewire, downweight,
  -- lineage edge) assumes the retire happened. Stop here instead, before any of
  -- it runs, and say which guard refused and why.
  IF NOT EXISTS (SELECT 1 FROM memories
                  WHERE id = p_old_id AND superseded_by = p_new_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'GV001',
      MESSAGE = format('supersede_memory: retiring %s was vetoed by memories_forget_guard; nothing was rewired', p_old_id),
      DETAIL  = COALESCE(
        (SELECT format('forget-guard veto_reason: %s', a.veto_reason)
           FROM memory_forget_audit a
          WHERE a.memory_id = p_old_id AND a.review_status = 'vetoed'
          ORDER BY a.id DESC LIMIT 1),
        'no veto row recorded; memories.superseded_by did not take the write'),
      HINT    = 'This is a governance decision, not a fault. Resolve the veto condition '
                '(retire the eval probe gold, or unset lifecycle_pinned) and re-run, or '
                'adjudicate the conflict by hand. Do NOT disable forget_guard_settings to force it.';
  END IF;

$chk$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'supersede_memory' AND n.nspname = 'public'
     AND pg_get_function_identity_arguments(p.oid) = 'p_old_id uuid, p_new_id uuid, p_reason text, p_heuristic text';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 138: supersede_memory(uuid,uuid,text,text) not found';
  END IF;
  IF position('VETO CHECK (migration 138' in v_def) > 0 THEN
    RAISE NOTICE 'migration 138: veto check already present, skipping';
  ELSE
    IF position(v_anchor in v_def) = 0 THEN
      RAISE EXCEPTION 'migration 138: rewire anchor not found in supersede_memory -- function drifted, patch by hand';
    END IF;
    -- Guard against a second occurrence silently patching the wrong site.
    IF position(v_anchor in substr(v_def, position(v_anchor in v_def) + length(v_anchor))) > 0 THEN
      RAISE EXCEPTION 'migration 138: rewire anchor is ambiguous -- patch by hand';
    END IF;
    v_new := replace(v_def, v_anchor, v_check || v_anchor);
    EXECUTE v_new;
    RAISE NOTICE 'migration 138: forget-guard veto check installed in supersede_memory';
  END IF;
END
$mig138$;

COMMENT ON FUNCTION public.supersede_memory(uuid, uuid, text, text) IS
  'TOKI supersession operator. Sets superseded_by + is_active=false (row PRESERVED), rewires inbound links onto the winner, writes the loser->winner ''supersedes'' edge, appends to memory_log. Migration 138: raises SQLSTATE GV001 if memories_forget_guard vetoed the retire, BEFORE any link is rewired or downweighted -- previously it carried on and died three statements later inside migration 105''s edge-direction trigger with an error that named neither the guard nor the reason.';

-- ── 2. Sweep driver: a veto is a decision, not an error ──────────────────────
ALTER TABLE public.conflict_sweep_runs
  ADD COLUMN IF NOT EXISTS vetoed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.conflict_sweep_runs.vetoed IS
  'Candidates refused by memories_forget_guard (SQLSTATE GV001, migration 138). Counted apart from errors: these need a human governance call, not a bug fix.';

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
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE NOT q.pit_deferred
                            AND (p_types IS NULL OR q.conflict_type = ANY(p_types))),
         count(*) FILTER (WHERE q.pit_deferred)
    INTO v_open_before, v_available, v_deferred
  FROM public.conflict_sweep_queue q;

  FOR r IN
    -- Candidates the resolver can actually act on. PIT-deferred rows are left
    -- OPEN and unresolved on purpose (migration 133 owns that judgement); they
    -- are merely no longer allowed to occupy the age-ordered head of the queue.
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

  SELECT count(*) INTO v_open_after FROM public.conflict_sweep_queue;

  INSERT INTO public.conflict_sweep_runs (
    actor, sweep_limit, open_before, candidates_available, pit_deferred,
    processed, adjudicated, skipped, vetoed, errors, actions, open_after)
  VALUES (p_actor, p_limit, v_open_before, v_available, v_deferred,
          v_total, v_total - v_skipped - v_vetoed - v_errors,
          v_skipped, v_vetoed, v_errors, v_actions, v_open_after);

  RETURN jsonb_build_object(
    'processed', v_total,
    'adjudicated', v_total - v_skipped - v_vetoed - v_errors,
    'skipped', v_skipped,
    'vetoed_forget_guard', v_vetoed,
    'errors', v_errors,
    'actions', v_actions,
    'candidates_available', v_available,
    'pit_deferred_not_selected', v_deferred,
    'open_conflicts_remaining', v_open_after);
END;
$$;

COMMENT ON FUNCTION public.sweep_conflicts(integer, text, text[]) IS
  'Batch driver for resolve_conflict_auto() (migration 063; candidate set narrowed by 137; veto classification added by 138). Called daily by contradiction_scan.py right after scan_memory_contradictions(). Candidates come from conflict_sweep_queue WHERE NOT pit_deferred, so the p_limit budget is never spent re-skipping point-in-time conflicts the resolver refuses by design and never resolves -- those blocked the age-ordered head of the queue from 2026-08-24 to 2026-08-26. Per-row exception handling retained; SQLSTATE GV001 (forget-guard veto) is counted as `vetoed`, not `errors`. Every call appends to conflict_sweep_runs; read `adjudicated`/`skipped`/`vetoed` there, not `processed`.';

REVOKE EXECUTE ON FUNCTION public.sweep_conflicts(integer, text, text[]) FROM anon, authenticated;

DROP VIEW IF EXISTS public.conflict_sweep_health;
CREATE VIEW public.conflict_sweep_health
WITH (security_invoker = true) AS
SELECT r.ran_at,
       r.actor,
       r.open_before,
       r.open_after,
       (r.open_before - r.open_after)            AS net_closed,
       r.candidates_available,
       r.pit_deferred,
       r.processed,
       r.adjudicated,
       r.skipped,
       r.vetoed,
       r.errors,
       round(100.0 * r.skipped / NULLIF(r.processed, 0), 1)    AS skipped_pct,
       round(100.0 * r.pit_deferred / NULLIF(r.open_before, 0), 1) AS deferred_pct_of_open,
       GREATEST(0, r.candidates_available - r.processed)       AS backlog_unreached,
       -- adjudicated=0 UNDER budget is a permanent refused residue, NOT budget
       -- exhaustion. Collapsing the two would repeat the very error migration
       -- 137 exists to fix.
       CASE
         WHEN r.processed = 0 AND r.candidates_available = 0 THEN 'idle — nothing adjudicable open'
         WHEN r.processed = 0                                THEN 'NOT RUNNING — candidates exist, none processed'
         WHEN r.adjudicated = 0 AND r.processed >= r.sweep_limit
              THEN 'SATURATED — full budget spent, zero adjudicated'
         WHEN r.adjudicated = 0
              THEN 'STALLED — every candidate refused or errored (under budget)'
         WHEN r.candidates_available > r.processed
              THEN 'BACKLOG — adjudicable work exceeded the budget'
         WHEN r.open_after > r.open_before                    THEN 'intake exceeds resolution this run'
         ELSE 'ok'
       END AS verdict
FROM public.conflict_sweep_runs r
ORDER BY r.ran_at DESC;

COMMENT ON VIEW public.conflict_sweep_health IS
  'Saturation readout over conflict_sweep_runs (migrations 137, 138). verdict distinguishes "no adjudicable work left" from "budget burned on rows the resolver refuses" — the 08-25/08-26 failure looked identical to healthy in the log because both report processed=200.';

REVOKE ALL ON public.conflict_sweep_health FROM anon, authenticated;

-- ── 3. Why is each open conflict stuck? (dry run, always rolled back) ────────
CREATE OR REPLACE FUNCTION public.conflict_block_report(p_limit integer DEFAULT 500)
RETURNS TABLE(conflict_id uuid, conflict_type text, created_at timestamptz,
              pit_deferred boolean, outcome text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r     RECORD;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT q.id, q.conflict_type AS ctype, q.created_at AS cat, q.pit_deferred AS pit
    FROM public.conflict_sweep_queue q
    ORDER BY q.created_at ASC
    LIMIT p_limit
  LOOP
    conflict_id  := r.id;
    conflict_type := r.ctype;
    created_at   := r.cat;
    pit_deferred := r.pit;
    -- Call the REAL resolver so this cannot drift from it, then force a
    -- rollback to this block's implicit savepoint either way. Nothing the
    -- resolver did — supersession, link rewire, memory_log — survives.
    BEGIN
      v_res   := public.resolve_conflict_auto(r.id, 'conflict-block-report(dry-run)');
      RAISE EXCEPTION USING ERRCODE = 'GV002', MESSAGE = COALESCE(v_res::text, '{}');
    EXCEPTION
      WHEN SQLSTATE 'GV002' THEN
        v_res   := SQLERRM::jsonb;
        outcome := COALESCE(v_res->>'action', 'unknown');
        reason  := v_res->>'reason';
      WHEN SQLSTATE 'GV001' THEN
        outcome := 'vetoed_forget_guard';
        reason  := SQLERRM;
      WHEN OTHERS THEN
        outcome := 'error ' || SQLSTATE;
        reason  := SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.conflict_block_report(integer) IS
  'DRY RUN over conflict_sweep_queue: reports what resolve_conflict_auto() would do to each OPEN conflict, by calling the real resolver in a savepoint that is always rolled back — no supersession, link rewire or memory_log entry survives. Use it to see WHY the residue is stuck (point-in-time, winner-itself-superseded, forget-guard veto, genuine error) without reading the resolver''s source and guessing. Migration 138.';

REVOKE EXECUTE ON FUNCTION public.conflict_block_report(integer) FROM anon, authenticated;
