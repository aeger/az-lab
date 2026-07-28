#!/usr/bin/env python3
"""Per-probe retrieval diagnostic — WHY a probe missed, not just THAT it missed.

WHY THIS EXISTS (2026-07-28, research tier 3(a))
  retrieval_regression.py answers "what is nDCG@10". It cannot answer the question
  that actually blocks tuning: is a low score weak RETRIEVAL or loose GOLD LABELS?
  Those have opposite fixes — one says change the ranker, the other says change the
  probes — and the aggregate number is identical either way.

  This dumps, per probe, the gold memory name(s) beside the top-5 returned names, so
  the misses can be read directly. It also reports top-5 slot OCCUPANCY across the
  whole probe set, which is what exposed the real defect: 79 distinct memories of
  ~872 occupy every top-5 slot, and `task-queue-system` takes one on 44.6% of probes
  regardless of topic. That is popularity concentration in the A-MAC lane, not a
  labelling problem. See memory `tier3a-ndcg-verdict-popularity-concentration-20260728`.

NON-MUTATING — AND THIS IS NOT OPTIONAL
  hybrid_recall increments access_count/recall_count/last_accessed_at on every row it
  returns (migration 071), and those columns feed the A-MAC scoring lane this script
  is measuring. A diagnostic that calls hybrid_recall directly therefore promotes
  whatever it retrieves and measures its own footprint — the popular rows get more
  popular on every pass. The first version of this script skipped the guard and
  perturbed 220 rows / 4149 excess accesses before it was caught and restored.
  So: same eval_lock() + snapshot/restore as retrieval_regression.py, restore in a
  finally block so a crash cannot leave the corpus perturbed.

USAGE
  python3 diagnose_probes.py                 # all non-forgetting probes
  python3 diagnose_probes.py --misses-only   # only probes with no gold in top-10
  python3 diagnose_probes.py --json out.json
"""
import argparse
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import retrieval_regression as rr  # noqa: E402

FORGETTING = rr.FORGETTING_CATEGORY
_names = {}


def names(ids):
    missing = [i for i in ids if i not in _names]
    if missing:
        for g in rr.sb_get("memories", {"select": "id,name",
                                        "id": f"in.({','.join(missing)})"}):
            _names[g["id"]] = g["name"]
        for i in missing:
            _names.setdefault(i, "<GONE/INACTIVE>")
    return [_names[i] for i in ids]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--misses-only", action="store_true")
    ap.add_argument("--json", help="also write the full per-probe dump here")
    args = ap.parse_args()

    rows = [q for q in rr.load_queries() if q["category"] != FORGETTING]
    out = []

    with rr.eval_lock("diagnose_probes"):
        snapped = rr.sb_rpc("eval_access_snapshot_take", {})
        print(f"access-stat snapshot taken ({snapped} rows) — diagnostic is non-mutating")
        try:
            for q in rows:
                gold = set(q["gold_memory_ids"] or [])
                returned = rr.retrieve(q["question"], q.get("topic_hint"), args.k)
                rank = next((i + 1 for i, m in enumerate(returned) if m in gold), None)
                out.append({
                    "category": q["category"], "question": q["question"],
                    "topic_hint": q.get("topic_hint"), "gold_rank": rank,
                    "ndcg_at_10": round(rr.ndcg_at(returned, gold, 10), 3),
                    "gold": names(sorted(gold)), "top5": names(returned[:5]),
                })
        finally:
            repaired = rr.sb_rpc("eval_access_snapshot_restore", {})
            print(f"access stats restored ({repaired} rows perturbed by this diagnostic)")

    n = len(out)
    nd = sum(x["ndcg_at_10"] for x in out) / n
    r5 = sum(1 for x in out if x["gold_rank"] and x["gold_rank"] <= 5) / n
    misses = [x for x in out if not x["gold_rank"]]
    print(f"\n=== {n} probes · nDCG@10 {nd:.4f} · recall@5 {r5:.3f} · {len(misses)} misses ===\n")

    for x in (misses if args.misses_only else out):
        mark = f"@{x['gold_rank']}" if x["gold_rank"] else "MISS"
        print(f"[{x['category']:<10}] {mark:<5} {x['question'][:78]}")
        print(f"    GOLD: {x['gold']}")
        print(f"    TOP5: {[t[:52] for t in x['top5']]}")

    # The occupancy view: which memories crowd the top-5 irrespective of the question.
    c = collections.Counter()
    for x in out:
        for nme in x["top5"]:
            c[nme] += 1
    print(f"\n=== top-5 slot occupancy (a hub here outranks on topic it does not match) ===")
    for nme, k in c.most_common(10):
        print(f"  {k:3d}  ({k / n * 100:4.1f}% of probes)  {nme[:58]}")
    print(f"\ndistinct memories ever in a top-5: {len(c)}")

    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1))
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
