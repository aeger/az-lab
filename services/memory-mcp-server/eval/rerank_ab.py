#!/usr/bin/env python3
"""
Reranker A/B — measure before swapping.

WHY THIS EXISTS (2026-08-06 research TIER 3, carried for three runs)
  az-tei-reranker serves BAAI/bge-reranker-base. Three consecutive daily research
  runs have recommended moving to bge-reranker-v2-m3 on the strength of published
  nDCG gains (+12.35 nDCG@10 for a small modern reranker on LMEB; 5-15% for
  two-stage over single-stage on BEIR). None of those numbers were measured on
  this corpus, on this hardware.

  The constraint that makes the published numbers non-transferable: svc-podman-01
  has NO GPU. TEI runs the cross-encoder on CPU, and in a two-stage pipeline the
  reranker IS the p95 bottleneck. v2-m3 is multilingual and heavier than
  bge-reranker-base. A model that scores better on BEIR and costs 3x the latency
  is not obviously an upgrade for an interactive recall path.

  So this script answers the only question that decides it: on az-lab's own probe
  set, what is the nDCG delta, and what does it cost in p50/p95?

WHAT IT DOES NOT DO
  It does not swap anything. It prints numbers. Promotion is a separate, human
  decision, and the honest outcome is allowed to be "won't fix on CPU".

METHOD — the part that makes it an A/B and not two benchmarks
  First-stage candidates are fetched ONCE per probe and replayed through every
  reranker. Both models therefore see byte-identical input in identical order, so
  every difference in the output ranking is attributable to the model. Re-running
  hybrid_recall per model would let embedding jitter and row-order ties leak into
  the comparison.

  Candidate text is built with the SAME format string as rerankWithTEI() in
  src/index.ts (name (type): description \\n content[:400]). Benchmarking a
  different text shape than production serves would measure a pipeline that does
  not exist.

  Latency is the /rerank call only — the thing that changes when the model
  changes. First-stage retrieval is common to both arms and is reported
  separately for context.

USAGE
  python3 rerank_ab.py                       # base vs v2-m3, default endpoints
  python3 rerank_ab.py --limit 20            # quick pass
  python3 rerank_ab.py --arm name=http://host:port/rerank
  python3 rerank_ab.py --json results/rerank_ab.json
"""
import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retrieval_regression import (  # noqa: E402
    embed, sb_get, sb_rpc, ndcg_at, die,
)

# Production shape, from compose.yml: hybrid recall returns 20, rerank cuts to 5.
FIRST_STAGE_K = 20
RERANK_TOP_K = 5

# Probe categories whose metric is an ABSENCE (a superseded memory must NOT come
# back) or an abstention. Reranking a candidate list cannot be scored by nDCG on
# those, so they are excluded from the positive population — same convention as
# retrieval_regression.score().
EXCLUDED_CATEGORIES = {"forgetting", "abstention"}

DEFAULT_ARMS = [
    ("bge-reranker-base",  "http://localhost:8086/rerank"),
    ("bge-reranker-v2-m3", "http://localhost:8087/rerank"),
]


def candidate_text(m: dict) -> str:
    """Byte-identical to rerankWithTEI() in src/index.ts."""
    return f"{m.get('name')} ({m.get('type')}): {m.get('description')}\n{(m.get('content') or '')[:400]}"


def load_probes(limit=None) -> list:
    rows = sb_get("eval_queries", {
        "select": "id,question,topic_hint,gold_memory_ids,category,tier",
        "active": "is.true",
        "order": "category,created_at",
    })
    probes = [
        r for r in rows
        if r.get("category") not in EXCLUDED_CATEGORIES and (r.get("gold_memory_ids") or [])
    ]
    if not probes:
        die("no gold-bearing probes in eval_queries")
    return probes[:limit] if limit else probes


def first_stage(question: str, topic_hint: str) -> tuple:
    """The real recall path, asked for the pre-rerank candidate window."""
    t0 = time.perf_counter()
    emb = embed(question)
    rows = sb_rpc("hybrid_recall", {
        "p_query_text": question,
        "p_query_embedding": json.dumps(emb),
        "p_match_threshold": 0.3,
        "p_match_count": FIRST_STAGE_K,
        "p_topic_hint": topic_hint,
    })
    return rows[:FIRST_STAGE_K], (time.perf_counter() - t0) * 1000


def rerank(url: str, query: str, texts: list, timeout: float = 30.0) -> tuple:
    """Returns (order, latency_ms). `order` is candidate indices, best first."""
    t0 = time.perf_counter()
    r = httpx.post(url, json={"query": query, "texts": texts, "truncate": True}, timeout=timeout)
    r.raise_for_status()
    out = r.json()
    ms = (time.perf_counter() - t0) * 1000
    return [d["index"] for d in sorted(out, key=lambda d: -d["score"])], ms


def mrr(returned: list, gold: set) -> float:
    for i, mid in enumerate(returned):
        if mid in gold:
            return 1.0 / (i + 1)
    return 0.0


def pct(values: list, p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    # Nearest-rank. n is small (<=100 calls per arm); linear interpolation would
    # invent precision the sample size does not support.
    k = max(0, min(len(s) - 1, int(round(p / 100.0 * len(s) + 0.5)) - 1))
    return s[k]


def summarise(name: str, per_probe: list, latencies: list) -> dict:
    n = len(per_probe)
    return {
        "arm": name,
        "n_probes": n,
        "ndcg_at_5":  sum(p["ndcg5"] for p in per_probe) / n if n else 0.0,
        "ndcg_at_10": sum(p["ndcg10"] for p in per_probe) / n if n else 0.0,
        "recall_at_5": sum(p["hit5"] for p in per_probe) / n if n else 0.0,
        "mrr": sum(p["mrr"] for p in per_probe) / n if n else 0.0,
        "latency_ms_p50": pct(latencies, 50),
        "latency_ms_p95": pct(latencies, 95),
        "latency_ms_mean": statistics.fmean(latencies) if latencies else 0.0,
        "latency_ms_max": max(latencies) if latencies else 0.0,
        "n_calls": len(latencies),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--arm", action="append", default=[],
                    help="name=url ; repeatable. Overrides the defaults entirely.")
    ap.add_argument("--json", type=str, default=None, help="write full results here")
    ap.add_argument("--warmup", type=int, default=3,
                    help="discarded calls per arm — TEI lazily allocates on first "
                         "inference and a cold call is not what production sees")
    args = ap.parse_args()

    arms = DEFAULT_ARMS
    if args.arm:
        arms = []
        for spec in args.arm:
            if "=" not in spec:
                die(f"--arm expects name=url, got {spec!r}")
            n, u = spec.split("=", 1)
            arms.append((n, u))

    for name, url in arms:
        try:
            httpx.get(url.replace("/rerank", "/info"), timeout=5).raise_for_status()
        except Exception as e:
            die(f"arm {name!r} unreachable at {url}: {e}")

    probes = load_probes(args.limit)
    print(f"probes: {len(probes)} (gold-bearing, excluding {sorted(EXCLUDED_CATEGORIES)})")
    print(f"first stage: hybrid_recall top-{FIRST_STAGE_K}  |  arms: {', '.join(n for n, _ in arms)}\n")

    # ---- Stage 1: fetch candidates ONCE. Shared by every arm. ----------------
    cases, fs_lat = [], []
    for i, p in enumerate(probes, 1):
        try:
            rows, ms = first_stage(p["question"], p.get("topic_hint") or "")
        except Exception as e:
            print(f"  ! probe {i} first-stage failed: {e}", file=sys.stderr)
            continue
        if len(rows) < 2:
            continue
        fs_lat.append(ms)
        cases.append({
            "probe": p,
            "rows": rows,
            "ids": [r["id"] for r in rows],
            "texts": [candidate_text(r) for r in rows],
            "gold": set(p["gold_memory_ids"] or []),
        })
        if i % 20 == 0:
            print(f"  ...{i}/{len(probes)} candidates fetched")

    if not cases:
        die("no usable probes after first-stage retrieval")
    print(f"first-stage: {len(cases)} usable probes, "
          f"p50 {pct(fs_lat,50):.0f}ms p95 {pct(fs_lat,95):.0f}ms\n")

    # ---- Stage 0: the no-rerank baseline ------------------------------------
    baseline = [{
        "ndcg5":  ndcg_at(c["ids"], c["gold"], 5),
        "ndcg10": ndcg_at(c["ids"], c["gold"], 10),
        "hit5":   1 if any(m in c["gold"] for m in c["ids"][:5]) else 0,
        "mrr":    mrr(c["ids"], c["gold"]),
    } for c in cases]
    results = [summarise("no-rerank (first stage)", baseline, [])]

    # ---- Stage 2: replay identical candidates through each arm --------------
    for name, url in arms:
        for c in cases[:args.warmup]:
            try:
                rerank(url, c["probe"]["question"], c["texts"])
            except Exception:
                pass

        per_probe, lat = [], []
        for c in cases:
            try:
                order, ms = rerank(url, c["probe"]["question"], c["texts"])
            except Exception as e:
                print(f"  ! {name} rerank failed: {e}", file=sys.stderr)
                continue
            lat.append(ms)
            ranked = [c["ids"][i] for i in order if 0 <= i < len(c["ids"])]
            per_probe.append({
                "ndcg5":  ndcg_at(ranked, c["gold"], 5),
                "ndcg10": ndcg_at(ranked, c["gold"], 10),
                "hit5":   1 if any(m in c["gold"] for m in ranked[:5]) else 0,
                "mrr":    mrr(ranked, c["gold"]),
            })
        results.append(summarise(name, per_probe, lat))
        print(f"  {name}: done ({len(lat)} calls)")

    # ---- Report --------------------------------------------------------------
    base = results[0]
    print(f"\n{'arm':<26} {'nDCG@5':>8} {'nDCG@10':>8} {'R@5':>7} {'MRR':>7} "
          f"{'p50 ms':>9} {'p95 ms':>9}")
    print("-" * 82)
    for r in results:
        print(f"{r['arm']:<26} {r['ndcg_at_5']:>8.4f} {r['ndcg_at_10']:>8.4f} "
              f"{r['recall_at_5']:>7.3f} {r['mrr']:>7.4f} "
              f"{r['latency_ms_p50']:>9.0f} {r['latency_ms_p95']:>9.0f}")

    incumbent = next((r for r in results if r["arm"] == "bge-reranker-base"), None)
    print("\ndeltas vs no-rerank baseline:")
    for r in results[1:]:
        print(f"  {r['arm']:<24} nDCG@10 {r['ndcg_at_10']-base['ndcg_at_10']:+.4f}  "
              f"nDCG@5 {r['ndcg_at_5']-base['ndcg_at_5']:+.4f}  "
              f"MRR {r['mrr']-base['mrr']:+.4f}  (+{r['latency_ms_p95']:.0f}ms p95)")

    if incumbent:
        print("\ndeltas vs incumbent (bge-reranker-base) — THIS is the promotion decision:")
        for r in results[1:]:
            if r["arm"] == incumbent["arm"]:
                continue
            d10 = r["ndcg_at_10"] - incumbent["ndcg_at_10"]
            d5 = r["ndcg_at_5"] - incumbent["ndcg_at_5"]
            dp95 = r["latency_ms_p95"] - incumbent["latency_ms_p95"]
            ratio = (r["latency_ms_p95"] / incumbent["latency_ms_p95"]) if incumbent["latency_ms_p95"] else 0
            print(f"  {r['arm']:<24} nDCG@10 {d10:+.4f}  nDCG@5 {d5:+.4f}  "
                  f"p95 {dp95:+.0f}ms ({ratio:.2f}x)")
            verdict = ("PROMOTE" if d10 > 0.01 and ratio < 1.5 else
                       "HOLD — gain does not clear the latency cost")
            print(f"  {'':<24} -> {verdict}")

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "first_stage_k": FIRST_STAGE_K, "rerank_top_k": RERANK_TOP_K,
            "n_probes": len(cases), "arms": results,
            "first_stage_latency_ms": {"p50": pct(fs_lat, 50), "p95": pct(fs_lat, 95)},
        }, indent=2))
        print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
