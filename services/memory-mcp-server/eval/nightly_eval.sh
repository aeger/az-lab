#!/usr/bin/env bash
# Nightly retrieval eval + regression gate.
# Ref: 2026-07-28 daily research, tier 1.
#
# WHY THIS EXISTS
#   retrieval_regression.py has existed since 2026-07-23 and had been run THREE times
#   by 2026-07-28. Migrations 065->078 all shipped against the recall path with no
#   measured retrieval delta — the harness was a thing you remembered to run, which
#   means it was a thing nobody ran. This makes it unconditional.
#
# WHAT IT DOES
#   1. run  — all active eval_queries through the real hybrid_recall path, recorded to
#             eval_runs with git_sha so a regression is attributable to a commit.
#   2. gate — compare nDCG@10 to the trailing 7-run median (Discord alert if >5%
#             below) AND to a fixed per-scoreset absolute floor. Both, because a
#             median-relative gate cannot see a decline slower than its window
#             and a fixed one cannot see a step change from a healthy baseline.
#
# The eval is NON-MUTATING: retrieval_regression.py snapshots access_count /
# recall_count / last_accessed_at before the run and restores them in a finally block
# (migration 071). Running it nightly therefore does not promote whatever it retrieves
# into the A-MAC scoring lane or perturb lifecycle tiering.
#
# Exit code is the GATE's, so `systemctl status` shows red exactly when retrieval
# regressed. A failed Discord post does not fail the unit.
set -uo pipefail

# SINGLE-INSTANCE GUARD — not optional.
# eval_access_snapshot_take() (migration 071) does TRUNCATE + re-INSERT on a SINGLE
# shared eval_access_snapshot table. Two overlapping runs therefore share one
# snapshot: the second take() captures access counts the first run has ALREADY
# perturbed, and whichever restores last writes those polluted values back as
# "truth". The runs also contaminate each other's scores mid-flight, because
# access_count feeds the A-MAC scoring lane they are both measuring.
# Hit for real on 2026-07-28: `systemctl enable --now` on a Persistent=true timer
# fired the missed 05:00 trigger immediately, concurrent with a manual run — two
# eval_runs rows 11s apart, 0.3802 vs 0.3644 for the same sha.
exec 9>/tmp/memory-eval-nightly.lock
if ! flock -n 9; then
  echo "another nightly eval is already running (lock held) — exiting" >&2
  exit 0
fi

REPO="/home/almty1/azlab"
EVAL_DIR="$REPO/services/memory-mcp-server/eval"
TAG="nightly-$(date -u +%Y%m%d)"

cd "$EVAL_DIR" || exit 2

GIT_SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git -C "$REPO" diff --quiet 2>/dev/null; then DIRTY=" (dirty worktree)"; fi

echo "=== $(date -u +%FT%TZ) nightly eval  tag=$TAG  sha=$GIT_SHA$DIRTY ==="

# HARD-TIER FLOORS — the absolute gate, as of 2026-08-02 (research REC 2).
#
# The `gate` step below is RELATIVE: it compares nDCG@10 to a trailing 7-run median,
# so a slow uniform decay stays green forever because the median decays with it.
# These two are ABSOLUTE floors, and they sit on the tier that can actually move.
# Migration 096 measured recall@5 bit-identical to fifteen decimals across six
# consecutive runs (control arm included), because every change so far reorders
# inside the top 5. The hard tier is built from near-duplicate distractor clusters,
# where the characteristic failure is the SIBLING row taking rank 1 — recall@5
# cannot see that; recall@1 registers it immediately.
#
# Floors are set from the 2026-08-02 baseline (tag hardtier-baseline-21, 19 scored
# hard probes): hard recall@1 0.368, hard nDCG@5 0.556. One probe is worth 0.053 of
# recall@1, so 0.26 is roughly two probes of slack — loose enough not to flap on a
# single reworded gold, tight enough that a real ranker regression trips it.
# RAISE these as the tier improves. Do not lower them to make a red run green:
# the harness refuses a floor on a tier thinner than MIN_HARD_TIER_FOR_GATE=8
# precisely so that "gate passed" can never mean "nothing was measured".
python3 retrieval_regression.py run --tag "$TAG" --git-sha "$GIT_SHA" \
  --fail-under-hard-recall1 0.26 \
  --fail-under-hard-ndcg5 0.45 \
  --notes "nightly automated run${DIRTY}"
RUN_RC=$?

# rc=2 is die() — the run REFUSED to record (embedder outage, retrieval failure rate
# over tolerance). Nothing was written, so there is no run for the gate to read and
# nothing for the refresh to quote. Bail.
# rc=1 is a floor breach, and the distinction matters: cmd_run records to eval_runs
# BEFORE it checks any floor, so the run exists and is scored. Continuing to the gate
# and the state refresh is correct — we still want the Discord line and the ground
# truth updated on a red night, which is exactly when someone will go read them.
# The breach is preserved in the exit code at the bottom.
if [ "$RUN_RC" -ge 2 ]; then
  echo "eval run refused to record (rc=$RUN_RC) — skipping gate" >&2
  exit "$RUN_RC"
fi
if [ "$RUN_RC" -ne 0 ]; then
  echo "hard-tier floor BREACHED (rc=$RUN_RC) — continuing to gate + refresh, unit will be red" >&2
fi

# --notify-ok posts the GREEN line too, not just regressions (2026-07-30 REC 1).
# Without it the forgetting lane and the control arm are invisible unless they
# breach — and FCFR sat at 0.0000 for six runs precisely because nothing ever
# printed it where Jeff would see it.
#
# The gate also enforces --min-fcfr-probes (default 4) on n_forgetting_scorable,
# the FCFR DENOMINATOR, and that default is deliberately not spelled out here so
# there is one place to raise it. Why it exists (2026-08-13): the denominator fell
# 4 -> 3 at 2026-08-11 21:16 when a forgetting probe's only forbidden row was
# retired, the run stayed green, and the 0.333 that followed was one real leak over
# a denominator that had shrunk underneath it. --max-fcfr reads a ratio and cannot
# tell "nothing leaked" from "nothing was measurable"; a denominator at 0 used to
# fall straight through to a pass.
#
# ABSOLUTE nDCG@10 FLOOR — added 2026-08-25 (research impl 2/2).
#
# Everything else in `gate` is median-relative, and the comment on the hard-tier
# floors above already predicted the consequence on 2026-08-02: "a slow uniform
# decay stays green forever because the median decays with it". It did. Within
# scoreset v4, nDCG@10 went 0.6891 (08-03) -> 0.6291 (08-25) — -8.7% over 22
# nights — and this gate printed "OK, within tolerance" every single night,
# because no single night's step exceeded -5.0%. The hard-tier floors above,
# which are absolute, are what finally registered it. So nDCG@10 gets one too.
#
# THE FLOOR IS SET FROM A BASELINE, NOT FROM TODAY. Scoreset v4 baseline is
# 0.689 (nightly-20260803, the first full run on the v4 probe set, 97 probes;
# 08-04 read 0.6902). Floor = 0.689 x 0.90 = 0.62. The slack is ~10x the largest
# same-night reproducibility spread on record (0.6347 vs 0.6291 on 08-25;
# 0.6796 vs 0.6781 on 08-11), so it cannot flap on run-to-run noise, but it is
# nowhere near loose enough to sit under a decline of the size we just measured.
#
# HEADROOM TONIGHT IS +0.0091. That is not a mistake and it is not a floor drawn
# under the decline — it is what "0.689 x 0.90" happens to evaluate to, and the
# thinness IS the finding. One more -1.5% night turns this unit red, which is the
# correct outcome for a drift that is real, ongoing, and still unexplained.
# RAISE this as retrieval recovers. Do not lower it to make a red run green.
#
# Keyed by scoreset version on purpose: nDCG@10 is a mean over the probe
# population, so a floor authored for v4's 97 probes says nothing about v5's set.
# A run on an UNDECLARED scoreset fails loudly rather than passing — on the night
# a scoreset is bumped the relative gate is also blind (no history on the new
# version), and a silent double-blackout is exactly the defect this closes.
python3 retrieval_regression.py gate --tag "$TAG" --window 7 --drop-pct 5.0 \
  --fail-under-ndcg10 4:0.62 \
  --notify-ok
GATE_RC=$?

# 3. skill outcome assertion (2026-08-04 daily research, TIER 1).
#
# Asserts that the procedural-memory loop is actually being fed: a skill with
# evidence of use and zero LIVE (non-backfilled) outcomes gets flagged. Migration
# 104 seeded the counters from 39 terminal agent_episodes, which fixes cold-start
# for the refine pass but says nothing about whether agents are self-reporting now
# — so the gate subtracts the seeded counts before it judges.
#
# Exit code is DISCARDED and deliberately not folded into FINAL_RC. This is
# telemetry about skill curation, not retrieval; a starved counter turning the
# retrieval unit red would bury the signal that matters behind the one that
# doesn't. It runs before the state refresh so its output lands next to the eval
# numbers in the same journal entry.
python3 skill_outcome_gate.py --min-evidence 3 --notify \
  || echo "skill outcome gate failed (non-fatal)" >&2

# 4. refresh — rewrite the ground-truth block in the memories row
#    name='memory-mcp-server' (2026-08-02 daily research, REC 3).
#
# That row is the most-recalled state record in the corpus and it seeds every
# daily-research run. On 2026-08-02 it asserted migration head 093 and 79 eval
# probes while disk said 096 and the DB said 100 — so every agent recalling it
# started from a day-stale picture, and the research task re-derived the same
# four numbers by hand every morning.
#
# Runs AFTER the gate on purpose: the block quotes the newest eval_runs row, so
# it must not run before this run has been recorded. Its exit code is discarded
# and deliberately NOT folded into GATE_RC — a documentation refresh failing must
# never turn the retrieval gate red, or the signal that matters gets lost behind
# the signal that does not.
python3 ../refresh_state_memory.py || echo "state-memory refresh failed (non-fatal)" >&2

# A hard-tier floor breach outranks the relative gate in the exit code. The floors
# are absolute and the gate is median-relative, so on a slow uniform decay the gate
# is the one that stays green — exiting GATE_RC unconditionally would have thrown
# the breach away after going to the trouble of measuring it.
FINAL_RC="$GATE_RC"
if [ "$RUN_RC" -ne 0 ]; then FINAL_RC="$RUN_RC"; fi

echo "=== done  rc=$FINAL_RC  (run=$RUN_RC gate=$GATE_RC) ==="
exit "$FINAL_RC"
