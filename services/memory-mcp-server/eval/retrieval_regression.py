#!/usr/bin/env python3
"""
Retrieval regression harness — the cheap gate in front of hybrid_recall.

WHY THIS EXISTS (2026-07-23 research rec 2):
  Six RRF lane weights, RRF k=60, a six-term A-MAC composite, rerank top-20->K, and
  a five-value trust multiplier have all been hand-tuned with no ground truth and no
  regression test. Migration 061's header documents the sharpest instance: the trust
  weight is applied at TWO separate scoring sites inside hybrid_recall that "MUST
  stay identical". Nothing currently notices if they drift apart.

WHAT THIS IS NOT:
  Not memory_eval.py. That harness measures INJECTION/BINDING (does an agent answer
  better with memory in context) and spends strategies x 2 LLM calls per item. This
  one makes ZERO LLM calls: embed the question, call hybrid_recall, ask whether the
  known-correct memory came back in the top K. It runs in seconds so it can sit in
  front of every migration that touches the recall path.

METRICS
  recall@k  fraction of queries where ANY gold memory appeared in the top k
  MRR       mean of 1/rank over the best-ranked gold hit (0 for a miss)

USAGE
  python3 retrieval_regression.py run --tag pre-065
  python3 retrieval_regression.py run --tag post-065 --compare pre-065
  python3 retrieval_regression.py run --tag ci --fail-under-recall5 0.60
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import httpx

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL_HOST", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def embed(text: str) -> list:
    r = httpx.post(f"{OLLAMA_URL}/api/embeddings",
                   json={"model": EMBED_MODEL, "prompt": text}, timeout=30)
    r.raise_for_status()
    return r.json()["embedding"]


def sb_get(path: str, params: dict) -> list:
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_post(path: str, body):
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/{path}", headers={**SB_HEADERS, "Prefer": "return=representation"},
                   json=body, timeout=45)
    r.raise_for_status()
    return r.json()


def sb_rpc(fn: str, body: dict) -> list:
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", headers=SB_HEADERS, json=body, timeout=45)
    r.raise_for_status()
    return r.json()


def load_queries() -> list:
    rows = sb_get("eval_queries", {
        "select": "id,question,topic_hint,gold_memory_ids,category",
        "active": "is.true",
        "order": "category,created_at",
    })
    if not rows:
        die("eval_queries is empty — seed it before running (migration 068).")
    return rows


def retrieve(question: str, topic_hint: str, k: int) -> list:
    """The REAL recall path, same call the MCP recall tool makes."""
    emb = embed(question)
    res = sb_rpc("hybrid_recall", {
        "p_query_text": question,
        "p_query_embedding": json.dumps(emb),
        "p_match_threshold": 0.3,
        "p_match_count": k,
        "p_topic_hint": topic_hint,
    })
    return [r["id"] for r in res][:k]


def ndcg_at(returned: list, gold: set, cut: int) -> float:
    """Binary-relevance nDCG@cut. Credits EVERY gold hit, position-discounted —
    so an order change that keeps gold in the top-k but demotes it still moves the
    number (recall@k is blind to rank inside k; MRR only credits the best hit).
    IDCG = the ideal ordering (all reachable gold packed at the top)."""
    dcg = sum(1.0 / math.log2(i + 2) for i, mid in enumerate(returned[:cut]) if mid in gold)
    ideal_hits = min(len(gold), cut)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_hits))
    return (dcg / idcg) if idcg else 0.0


def score(rows: list, k: int, verbose: bool):
    results, hits1, hits5, hits10, rr_total = [], 0, 0, 0, 0.0
    ndcg5_total, ndcg10_total = 0.0, 0.0

    for q in rows:
        gold = set(q["gold_memory_ids"] or [])
        t0 = time.time()
        try:
            returned = retrieve(q["question"], q.get("topic_hint"), k)
        except Exception as e:  # a failed retrieval is a miss, not a crash
            print(f"  ! retrieval failed for {q['id']}: {e}", file=sys.stderr)
            returned = []
        latency = int((time.time() - t0) * 1000)

        rank = next((i + 1 for i, mid in enumerate(returned) if mid in gold), None)
        if rank:
            rr_total += 1.0 / rank
            hits1 += rank <= 1
            hits5 += rank <= 5
            hits10 += rank <= 10
        nd5, nd10 = ndcg_at(returned, gold, 5), ndcg_at(returned, gold, 10)
        ndcg5_total += nd5
        ndcg10_total += nd10

        results.append({
            "query_id": q["id"], "gold_rank": rank, "hit_at_5": bool(rank and rank <= 5),
            "returned_ids": returned, "latency_ms": latency, "ndcg_at_10": round(nd10, 4),
        })
        if verbose:
            mark = f"@{rank}" if rank else "MISS"
            print(f"  [{q['category']:<10}] {mark:<6} nDCG@10={nd10:.2f}  {q['question'][:56]}")

    n = len(rows)
    return results, {
        "n_queries": n,
        "recall_at_1": hits1 / n,
        "recall_at_5": hits5 / n,
        "recall_at_10": hits10 / n,
        "mrr": rr_total / n,
        "ndcg_at_5": ndcg5_total / n,
        "ndcg_at_10": ndcg10_total / n,
    }


def by_category(rows, results):
    cat = {}
    idx = {r["query_id"]: r for r in results}
    for q in rows:
        c = cat.setdefault(q["category"], {"n": 0, "hit5": 0})
        c["n"] += 1
        c["hit5"] += idx[q["id"]]["hit_at_5"]
    return cat


def cmd_run(args):
    if not SUPABASE_URL or not SUPABASE_KEY:
        die("SUPABASE_URL / SUPABASE_SECRET_KEY missing (expected in ../.env)")

    rows = load_queries()

    # hybrid_recall increments access_count/recall_count/last_accessed_at on every
    # row it returns (see migration 071). Those columns feed the A-MAC scoring lane
    # AND lifecycle tiering, so an unguarded eval run would promote whatever it
    # retrieves and corrupt the never-accessed statistic. Snapshot first, restore
    # in a finally block so a crash mid-run cannot leave the corpus perturbed.
    snapped = sb_rpc("eval_access_snapshot_take", {})
    print(f"access-stat snapshot taken ({snapped} rows) — eval will be non-mutating")

    print(f"Running {len(rows)} eval queries (k={args.k}) against hybrid_recall …")
    try:
        results, m = score(rows, args.k, args.verbose)
    finally:
        repaired = sb_rpc("eval_access_snapshot_restore", {})
        print(f"access stats restored ({repaired} rows perturbed by this run)")

    run = sb_post("eval_runs", {
        "tag": args.tag, "git_sha": args.git_sha, "notes": args.notes, **m,
    })[0]
    sb_post("eval_run_results", [{"run_id": run["id"], **r} for r in results])

    print(f"\n=== {args.tag} ===")
    print(f"  n          {m['n_queries']}")
    print(f"  recall@1   {m['recall_at_1']:.3f}")
    print(f"  recall@5   {m['recall_at_5']:.3f}")
    print(f"  recall@10  {m['recall_at_10']:.3f}")
    print(f"  MRR        {m['mrr']:.3f}")
    print(f"  nDCG@5     {m['ndcg_at_5']:.3f}")
    print(f"  nDCG@10    {m['ndcg_at_10']:.3f}")
    print("  by category (recall@5):")
    for c, v in sorted(by_category(rows, results).items()):
        print(f"    {c:<12} {v['hit5']}/{v['n']}  ({v['hit5']/v['n']:.2f})")

    if args.compare:
        prev = sb_get("eval_runs", {"select": "tag,recall_at_5,mrr,ndcg_at_10", "tag": f"eq.{args.compare}",
                                    "order": "created_at.desc", "limit": "1"})
        if not prev:
            print(f"\n  (no prior run tagged '{args.compare}' to compare against)")
        else:
            p = prev[0]
            d5, dm = m["recall_at_5"] - p["recall_at_5"], m["mrr"] - p["mrr"]
            dn = m["ndcg_at_10"] - (p.get("ndcg_at_10") or 0.0)
            print(f"\n  vs {args.compare}:  recall@5 {d5:+.3f}   MRR {dm:+.3f}   nDCG@10 {dn:+.3f}")
            # gate on recall@5 OR nDCG@10 slipping past tolerance — an order-only
            # regression (gold demoted but still in top-k) trips nDCG while recall holds.
            if d5 < -args.tolerance or dn < -args.tolerance:
                print(f"  REGRESSION: recall@5 or nDCG@10 dropped more than {args.tolerance}", file=sys.stderr)
                return 1

    if args.fail_under_recall5 is not None and m["recall_at_5"] < args.fail_under_recall5:
        print(f"  FAIL: recall@5 {m['recall_at_5']:.3f} < floor {args.fail_under_recall5}", file=sys.stderr)
        return 1
    return 0


def cmd_trend(args):
    for r in sb_get("eval_run_trend", {"select": "*", "limit": str(args.limit)}):
        print(f"{str(r['created_at'])[:19]}  {r['tag']:<16} "
              f"recall@5={r['recall_at_5']}  MRR={r['mrr']}  nDCG@10={r.get('ndcg_at_10')}  "
              f"Δr5={r['d_recall_at_5']}  Δmrr={r['d_mrr']}  Δndcg={r.get('d_ndcg_at_10')}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run the eval set and record a run")
    r.add_argument("--tag", required=True)
    r.add_argument("--k", type=int, default=10, help="retrieval depth (recall@10 needs >=10)")
    r.add_argument("--compare", help="prior run tag to diff against")
    r.add_argument("--tolerance", type=float, default=0.02, help="allowed recall@5 drop vs --compare")
    r.add_argument("--fail-under-recall5", type=float, default=None, help="hard floor for CI")
    r.add_argument("--git-sha", default=os.environ.get("GIT_SHA"))
    r.add_argument("--notes")
    r.add_argument("-v", "--verbose", action="store_true")
    r.set_defaults(func=cmd_run)

    t = sub.add_parser("trend", help="show recent runs")
    t.add_argument("--limit", type=int, default=10)
    t.set_defaults(func=cmd_trend)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
