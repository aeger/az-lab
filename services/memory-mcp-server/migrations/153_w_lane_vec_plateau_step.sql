-- ---------------------------------------------------------------------------
-- 153: recall_weights.w_lane_vec 1.0 -> 1.20
-- ---------------------------------------------------------------------------
-- Jeff approved 2026-09-07. Provenance per
-- system_rules.scoring_function_migration_required: recall_weights is never
-- changed by direct UPDATE without a numbered migration in the same session.
--
-- ORIGIN
--   EvolveMem recall diagnosis 2026-09-07 (task f59de6fd) proposed two knobs.
--   Sweep (task c7c55962, report eval/results/evolvemem/sweep_20260907.md):
--     H1 w_lane_vec  1.0 -> 1.3   CONFIRMED (mechanism partly wrong, see below)
--     H2 w_recency   0.1316->0.17 REFUTED — inverted gradient, a null. Not applied.
--
--   A harness bug was found and fixed first (commit 85c45a5): tune_ranker.KEYS
--   omitted the five per-lane weights hybrid_recall actually reads, so a lane
--   sweep would have run baseline twice and reported a tie. Every number below
--   post-dates that fix. Baseline was re-run as an arm in three separate sweeps
--   and returned bit-identical each time, so the harness is deterministic and
--   these deltas are real ranking changes.
--
-- WHY 1.20 AND NOT THE PROPOSED 1.30
--   Measured, 76 clean probes (118 total, leakage-filtered):
--
--     w_lane_vec  cleanNDCG  cleanR@5  env_gotcha  forgetting  temporal  multi_hop  single_hop
--     1.00 (live)   0.471     0.632       0.52        0.54        0.75      0.77       0.90
--     1.10          0.486     0.632       0.52        0.54        0.75      0.77       0.90
--     1.15-1.25     0.487     0.645       0.52        0.54        0.83      0.85       0.90
--     1.30-1.50     0.485     0.658       0.52        0.46 <--    0.92      0.85       0.90
--     2.00          0.508     0.658       0.57        0.54        0.92      0.85       0.86 <--
--
--   1.15/1.20/1.25 are bit-identical to each other -- a flat step, not a point --
--   and are the ONLY arms that improve every category they move while regressing
--   NONE. 1.30 buys temporal (0.83->0.92) but costs a `forgetting` probe
--   (0.54->0.46). 2.00 has the best headline and is the only arm where env_gotcha
--   moves at all, but it regresses single_hop (0.90->0.86).
--
--   1.20 is chosen over 1.15 because the step boundary sits between 1.10 and 1.15:
--   at 1.10 the R@5/temporal/multi_hop gains are absent, at 1.15 they are present.
--   1.15 therefore sits exactly ON the boundary. 1.20 is the midpoint of the flat
--   step, metrically identical, with margin on both sides against corpus drift.
--
--   The diagnosis argued this knob from env_gotcha. That mechanism is WRONG:
--   env_gotcha hit@5 is 0.52 at 1.20, unchanged from baseline, and only moves at
--   >= 2.0. The gain here is temporal (0.75->0.83) and multi_hop (0.77->0.85).
--   Recorded so nobody later "restores" this weight believing it serves
--   env_gotcha.
--
-- HONEST LIMIT
--   Effect sizes are 1-3 probes (clean R@5 0.632 -> 0.645 is ~1 of 76). The
--   direction is well supported -- all 11 arms in [1.05, 3.00] beat baseline --
--   but the per-arm magnitude is at the edge of this harness's resolution.
--
-- ROLLBACK
--   UPDATE public.recall_weights SET w_lane_vec = 1.0 WHERE id;   -- plus a
--   numbered migration, per the same provenance rule that required this one.
-- ---------------------------------------------------------------------------

BEGIN;

DO $mig$
DECLARE
  v_before numeric;
  v_after  numeric;
BEGIN
  SELECT w_lane_vec INTO v_before FROM public.recall_weights WHERE id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'migration 153: recall_weights singleton row not found';
  END IF;

  -- Guard against re-application over a hand-edited value: only step off the
  -- 1.0 baseline this migration was measured against.
  IF v_before <> 1.0 THEN
    RAISE NOTICE 'migration 153: w_lane_vec is % (expected 1.0) — leaving it alone', v_before;
    RETURN;
  END IF;

  UPDATE public.recall_weights
     SET w_lane_vec = 1.20,
         updated_at = now(),
         notes = COALESCE(notes, '') || E'\n\n2026-09-07 (migration 153): w_lane_vec 1.0 -> 1.20.'
              || E' EvolveMem sweep 20260907, 76 clean probes. Chosen as the midpoint of the'
              || E' bit-identical 1.15-1.25 flat step: the only arms that improve every category'
              || E' they move (temporal 0.75->0.83, multi_hop 0.77->0.85, clean R@5 0.632->0.645)'
              || E' while regressing none. 1.30 was proposed and approved but costs a forgetting'
              || E' probe (0.54->0.46); 2.00 scores highest but regresses single_hop (0.90->0.86).'
              || E' NOTE: the diagnosis argued this knob from env_gotcha and that mechanism is'
              || E' WRONG -- env_gotcha is unchanged at 0.52 here and only moves at >= 2.0.'
              || E' Effect size is 1-3 probes; direction is solid, magnitude is at harness'
              || E' resolution. H2 (w_recency -> 0.17) was REFUTED and is not applied.'
   WHERE id;

  SELECT w_lane_vec INTO v_after FROM public.recall_weights WHERE id;

  IF v_after <> 1.20 THEN
    RAISE EXCEPTION 'migration 153: w_lane_vec is % after update, expected 1.20', v_after;
  END IF;

  -- The other four lane weights and the composite must be untouched: this
  -- migration moves exactly one knob, and a sweep that moved more than it
  -- claimed is the failure this whole exercise started from.
  PERFORM 1 FROM public.recall_weights
   WHERE id
     AND w_lane_bm25w = 1.2 AND w_lane_bm25p = 0.8
     AND w_lane_topic = 1.5 AND w_lane_entity = 1.3
     AND w_recency = 0.1316;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 153: a weight other than w_lane_vec changed — aborting';
  END IF;

  RAISE NOTICE 'migration 153: w_lane_vec % -> % (all other weights verified unchanged)', v_before, v_after;
END;
$mig$;

COMMIT;
