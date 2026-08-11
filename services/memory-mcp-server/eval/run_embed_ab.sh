#!/usr/bin/env bash
# run_embed_ab.sh — score the candidate embedding model against the live one.
#
# REC 1, 2026-08-03 research. Waits for embed_ab_backfill.py to finish populating
# memories.embedding_v2, then runs BOTH arms back to back.
#
# WHY A FRESH CONTROL RUN rather than diffing against the recorded nightly:
# the corpus moved today (rows added, the state record recreated). Comparing a
# candidate run against a baseline taken on a different corpus would attribute
# corpus drift to the embedding model. Both arms are run minutes apart, on the
# same probes, same gold, same reranker — the only difference is EMBED_MODEL and
# which column the vector lane reads.
set -uo pipefail
cd "$(dirname "$0")"

STAMP="${1:-20260811}"

echo "=== waiting for the main embedding_v2 backfill process to exit ==="
# Wait on the PROCESS, not on "missing == 0". The corpus grows while the ~2h
# backfill runs (agents write memories throughout), so the missing count has a
# moving floor and a `until missing == 0` loop would spin forever.
while pgrep -f "embed_ab_backfill.py --model" >/dev/null; do
  python3 embed_ab_backfill.py --verify 2>/dev/null | tail -1
  sleep 60
done

echo "=== catch-up passes for rows written during the backfill ==="
for pass in 1 2 3; do
  MISSING=$(python3 embed_ab_backfill.py --verify 2>/dev/null | awk '/^missing/{print $3}')
  echo "pass ${pass}: ${MISSING} missing"
  [ "${MISSING:-0}" -eq 0 ] && break
  python3 embed_ab_backfill.py --model qwen3-embedding:0.6b --only-missing 2>&1 | tail -3
done

echo "final coverage before scoring:"
python3 embed_ab_backfill.py --verify
# Report, do not hide, any residual gap: rows still NULL score as vector-lane
# misses for the CANDIDATE arm only, which biases the A/B against it.
FINAL_MISSING=$(python3 embed_ab_backfill.py --verify 2>/dev/null | awk '/^missing/{print $3}')
if [ "${FINAL_MISSING:-0}" -ne 0 ]; then
  echo "WARNING: ${FINAL_MISSING} row(s) still lack embedding_v2 — the candidate arm"
  echo "         is handicapped by exactly that many vector-lane misses. Treat a"
  echo "         narrow candidate loss as inconclusive."
fi

echo
echo "=== ARM A (control): nomic-embed-text via hybrid_recall ==="
RECALL_FN=hybrid_recall EMBED_MODEL=nomic-embed-text EMBED_TRUNCATE_DIMS=0 \
  python3 retrieval_regression.py run --tag "embed-ab-control-${STAMP}" --k 10 2>&1 | tail -25

echo
echo "=== ARM B (candidate): qwen3-embedding:0.6b (MRL 768) via hybrid_recall_v2 ==="
RECALL_FN=hybrid_recall_v2 EMBED_MODEL=qwen3-embedding:0.6b EMBED_TRUNCATE_DIMS=768 \
  python3 retrieval_regression.py run --tag "embed-ab-qwen3-${STAMP}" \
  --compare "embed-ab-control-${STAMP}" --k 10 2>&1 | tail -35

echo
echo "=== DONE — adopt ONLY if the candidate wins the HARD tier ==="
