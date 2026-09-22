#!/usr/bin/env python3
"""Falsify the w_lane_entity null: does 1.3 -> 1.5 reorder ANY returned id list?

The 2026-07-31 IDF A/B was retracted because two arms reported bit-identical
metrics for a treatment that was never applied. The 2026-09-07 sweep found the
same class of bug (lane weights missing from KEYS). This asserts the treatment
reaches the arithmetic by diffing full returned id lists, per the standing rule
in recall_weights.notes -- summary floats are not sufficient evidence.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, "/home/almty1/azlab/services/memory-mcp-server/eval")
import retrieval_regression as rr
import tune_ranker as tr

rows = rr.load_queries()
embs = json.loads(tr.CACHE.read_text())
ARMS = [("1.30-live", 1.3), ("1.50-proposed", 1.5), ("6.00-positive-control", 6.0)]

def lists_for(w):
    tr.set_weights({**{k: live[k] for k in tr.KEYS}, "w_lane_entity": w})
    out = {}
    for q in rows:
        res = rr.sb_rpc("hybrid_recall", {
            "p_query_text": q["question"],
            "p_query_embedding": json.dumps(embs[q["id"]]),
            "p_match_threshold": 0.3, "p_match_count": 10,
            "p_topic_hint": q.get("topic_hint"),
        })
        out[q["id"]] = [r["id"] for r in res]
    rr.sb_rpc("eval_access_snapshot_restore", {})
    return out

live = tr.read_weights()
with rr.eval_lock("falsify_entity list-diff"):
    rr.sb_rpc("eval_access_snapshot_take", {})
    try:
        got = {}
        for name, w in ARMS:
            got[name] = lists_for(w)
            print(f"  collected {name} ({len(got[name])} probes)")
    finally:
        tr.set_weights({k: live[k] for k in tr.KEYS})
        rr.sb_rpc("eval_access_snapshot_restore", {})
        print("weights + access stats restored")

base = got["1.30-live"]
for name, _ in ARMS[1:]:
    arm = got[name]
    diff_any  = [q for q in base if base[q] != arm[q]]
    diff_top1 = [q for q in base if (base[q][:1] or [None]) != (arm[q][:1] or [None])]
    diff_top5 = [q for q in base if base[q][:5] != arm[q][:5]]
    print(f"\n{name} vs 1.30-live:")
    print(f"  full 10-item list differs : {len(diff_any):>3}/{len(base)} probes")
    print(f"  top-5 differs             : {len(diff_top5):>3}/{len(base)} probes")
    print(f"  rank-1 differs            : {len(diff_top1):>3}/{len(base)} probes")

print("\nlive w_lane_entity now:", tr.read_weights()["w_lane_entity"])
