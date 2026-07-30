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
#   2. gate — compare nDCG@10 to the trailing 7-run median; Discord alert if >5% below.
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

python3 retrieval_regression.py run --tag "$TAG" --git-sha "$GIT_SHA" \
  --notes "nightly automated run${DIRTY}"
RUN_RC=$?
if [ "$RUN_RC" -ne 0 ]; then
  echo "eval run failed (rc=$RUN_RC) — skipping gate" >&2
  exit "$RUN_RC"
fi

# --notify-ok posts the GREEN line too, not just regressions (2026-07-30 REC 1).
# Without it the forgetting lane and the control arm are invisible unless they
# breach — and FCFR sat at 0.0000 for six runs precisely because nothing ever
# printed it where Jeff would see it.
python3 retrieval_regression.py gate --tag "$TAG" --window 7 --drop-pct 5.0 --notify-ok
GATE_RC=$?

echo "=== done  rc=$GATE_RC ==="
exit "$GATE_RC"
