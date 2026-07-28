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
import contextlib
import fcntl
import json
import math
import os
import statistics
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


def embed(text: str, attempts: int = 4) -> list:
    """Embed with bounded retry.

    Ollama refuses connections for a few seconds when it swaps a model or restarts.
    Without a retry those queries raise, score() counts them as MISSES, and the run
    records a score that measures Ollama's uptime rather than retrieval quality.
    Hit for real on 2026-07-28: 18 of 56 queries took [Errno 111] Connection refused
    mid-run and the run landed in eval_runs at recall@5 0.482 — an 0.089 "regression"
    that was entirely an artefact. Retrying is not politeness, it is the difference
    between a gate that means something and one that cries wolf."""
    last = None
    for i in range(attempts):
        try:
            r = httpx.post(f"{OLLAMA_URL}/api/embeddings",
                           json={"model": EMBED_MODEL, "prompt": text}, timeout=30)
            r.raise_for_status()
            return r.json()["embedding"]
        except Exception as e:
            last = e
            if i < attempts - 1:
                time.sleep(1.5 * (2 ** i))  # 1.5s, 3s, 6s
    raise last


@contextlib.contextmanager
def eval_lock(what: str, wait_s: int = 1800):
    """Serialise every harness invocation against every other one.

    eval_access_snapshot_take() TRUNCATEs and re-INSERTs a SINGLE shared table
    (migration 071). Two overlapping runs therefore share one snapshot: the second
    take() captures access counts the first has already perturbed, and whichever
    restores last writes those polluted values back as truth.

    nightly_eval.sh already took a flock, but that only guards ITSELF — a manual
    `retrieval_regression.py run`, a sweep, or a second agent invoking the harness
    directly all bypassed it. On 2026-07-28 a sibling task-queue agent ran an eval
    (tag pre-076-078) 58 seconds before this one, concurrently, through exactly that
    hole. The lock belongs in the harness, where every path must pass through it.

    Waits rather than exits: a queued run finishes late, a skipped run leaves a hole
    in the trend line the gate medians over."""
    path = "/tmp/memory-eval-harness.lock"
    fh = open(path, "w")
    t0 = time.time()
    try:
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() - t0 > wait_s:
                    die(f"{what}: another eval held {path} for >{wait_s}s — aborting "
                        f"rather than corrupting its access snapshot")
                if time.time() - t0 < 1.5:
                    print(f"  … another eval is running; waiting for {path}")
                time.sleep(3)
        yield
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


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
    failures = 0

    for q in rows:
        gold = set(q["gold_memory_ids"] or [])
        t0 = time.time()
        try:
            returned = retrieve(q["question"], q.get("topic_hint"), k)
        except Exception as e:  # a failed retrieval is a miss, not a crash
            print(f"  ! retrieval failed for {q['id']}: {e}", file=sys.stderr)
            returned = []
            failures += 1
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
    }, failures


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

    with eval_lock(f"run --tag {args.tag}"):
        # hybrid_recall increments access_count/recall_count/last_accessed_at on every
        # row it returns (see migration 071). Those columns feed the A-MAC scoring lane
        # AND lifecycle tiering, so an unguarded eval run would promote whatever it
        # retrieves and corrupt the never-accessed statistic. Snapshot first, restore
        # in a finally block so a crash mid-run cannot leave the corpus perturbed.
        snapped = sb_rpc("eval_access_snapshot_take", {})
        print(f"access-stat snapshot taken ({snapped} rows) — eval will be non-mutating")

        print(f"Running {len(rows)} eval queries (k={args.k}) against hybrid_recall …")
        try:
            results, m, failures = score(rows, args.k, args.verbose)
        finally:
            repaired = sb_rpc("eval_access_snapshot_restore", {})
            print(f"access stats restored ({repaired} rows perturbed by this run)")

    # A run with failed retrievals scored those queries as misses. Recording it would
    # put a number measuring infrastructure availability into eval_runs, where the
    # nightly gate medians over it for the next 7 runs — so one Ollama blip poisons a
    # week of gating and the alert it eventually fires is unattributable. Refuse.
    fail_pct = failures / max(len(rows), 1)
    if failures and fail_pct > args.max_fail_pct:
        die(f"{failures}/{len(rows)} retrievals FAILED ({fail_pct:.0%} > "
            f"{args.max_fail_pct:.0%} tolerance) — refusing to record a run whose score "
            f"reflects an outage, not retrieval. Fix the embedder and re-run.")
    if failures:
        print(f"  ! {failures}/{len(rows)} retrievals failed (within "
              f"{args.max_fail_pct:.0%} tolerance) — recording, but treat as noisy")

    run = sb_post("eval_runs", {
        "tag": args.tag, "git_sha": args.git_sha,
        "notes": (args.notes or "") + (f" [{failures} retrieval failures]" if failures else ""),
        **m,
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


def discord(msg: str) -> bool:
    """Alert Jeff via agent-bus. NOTE: there is no /send-discord HTTP route on :8765 —
    the only working path is notify.send(), the same one the agent-bus MCP tool calls.
    Never let a dead bus turn a green eval into a failed unit."""
    try:
        sys.path.insert(0, os.path.expanduser("~/claude/agent-bus"))
        import notify
        return bool(notify.send(msg, channel="claude-code"))
    except Exception as e:
        print(f"  ! Discord alert failed ({e}) — gate verdict still stands", file=sys.stderr)
        return False


RERANKER_URL = os.environ.get("RERANKER_SWEEP_URL", "http://localhost:8087").rstrip("/")
TEI_MAX_BATCH = int(os.environ.get("TEI_MAX_BATCH", "32"))  # TEI /info max_client_batch_size


def retrieve_rows(question: str, topic_hint: str, k: int) -> list:
    """Same call as retrieve(), but keep the FULL rows — the rerank text needs
    name/type/description/content, all of which hybrid_recall already returns."""
    emb = embed(question)
    return sb_rpc("hybrid_recall", {
        "p_query_text": question,
        "p_query_embedding": json.dumps(emb),
        "p_match_threshold": 0.3,
        "p_match_count": k,
        "p_topic_hint": topic_hint,
    })


def tei_rerank(query: str, rows: list) -> list:
    """Byte-for-byte the production rerank path (src/index.ts rerankWithTEI):
    same text template, same `truncate: true`, same descending-score sort, same
    container. Replicated here rather than driven through the MCP server so a depth
    sweep costs no deploys — but it MUST stay in sync with rerankWithTEI or the
    sweep optimises something production does not run."""
    if len(rows) <= 1:
        return rows
    texts = [f"{m.get('name')} ({m.get('type')}): {m.get('description')}\n"
             f"{(m.get('content') or '')[:400]}" for m in rows]

    # TEI enforces max_client_batch_size=32 and 422s the WHOLE request above it.
    # Chunking is exact, not an approximation: a cross-encoder scores each
    # (query, text) pair independently, so batch composition cannot change a score.
    # NOTE FOR PRODUCTION: src/index.ts sends the pool in ONE request, so any
    # rerank depth > 32 there 422s -> rerankWithTEI returns null -> silent fallback.
    # Raising the depth in production REQUIRES this same chunking.
    scores = []
    for off in range(0, len(texts), TEI_MAX_BATCH):
        chunk = texts[off:off + TEI_MAX_BATCH]
        r = httpx.post(f"{RERANKER_URL}/rerank",
                       json={"query": query, "texts": chunk, "truncate": True}, timeout=60)
        r.raise_for_status()
        scores.extend({"index": x["index"] + off, "score": x["score"]} for x in r.json())
    ranked = sorted(scores, key=lambda x: x["score"], reverse=True)
    return [rows[x["index"]] for x in ranked]


def cmd_sweep(args):
    """Rerank candidate-depth sweep (2026-07-28 research tier 2).

    recall@5 = 0.50 at the 2026-07-24 baseline means half the gold never reaches the
    reranker at all. Deepening the RRF candidate pool can only help if the gold is
    actually DOWN there — this measures whether it is, and what it costs in latency.

    Depth 0 is the control: no rerank, pure RRF/A-MAC order (what the nightly gate
    measures today, and what the eval harness has always measured)."""
    depths = [int(d) for d in args.depths.split(",")]
    rows = load_queries()
    print(f"sweeping depths {depths} over {len(rows)} queries "
          f"(reranker: {RERANKER_URL})\n")

    lock = eval_lock(f"sweep --depths {args.depths}")
    lock.__enter__()
    snapped = sb_rpc("eval_access_snapshot_take", {})
    print(f"access-stat snapshot taken ({snapped} rows) — sweep will be non-mutating\n")
    table = []
    try:
        for depth in depths:
            hits5 = hits10 = 0
            nd5_t = nd10_t = rr_t = 0.0
            lats = []
            for q in rows:
                gold = set(q["gold_memory_ids"] or [])
                t0 = time.time()
                try:
                    cands = retrieve_rows(q["question"], q.get("topic_hint"),
                                          depth if depth > 0 else 10)
                    if depth > 0:
                        cands = tei_rerank(q["question"], cands)
                    returned = [c["id"] for c in cands][:10]
                except Exception as e:
                    print(f"  ! depth={depth} query {q['id']}: {e}", file=sys.stderr)
                    returned = []
                lats.append((time.time() - t0) * 1000)

                rank = next((i + 1 for i, m in enumerate(returned) if m in gold), None)
                if rank:
                    rr_t += 1.0 / rank
                    hits5 += rank <= 5
                    hits10 += rank <= 10
                nd5_t += ndcg_at(returned, gold, 5)
                nd10_t += ndcg_at(returned, gold, 10)

            n = len(rows)
            lats.sort()
            row = {
                "depth": depth,
                "recall_at_5": hits5 / n, "recall_at_10": hits10 / n, "mrr": rr_t / n,
                "ndcg_at_5": nd5_t / n, "ndcg_at_10": nd10_t / n,
                "p50_ms": lats[len(lats) // 2], "p95_ms": lats[int(len(lats) * 0.95) - 1],
            }
            table.append(row)
            print(f"  depth {depth:>3}: recall@5 {row['recall_at_5']:.3f}  "
                  f"nDCG@10 {row['ndcg_at_10']:.4f}  "
                  f"p50 {row['p50_ms']:.0f}ms  p95 {row['p95_ms']:.0f}ms")

            if args.record:
                sb_post("eval_runs", {
                    "tag": f"{args.tag_prefix}-d{depth}", "git_sha": args.git_sha,
                    "n_queries": n, "recall_at_1": 0.0,
                    "recall_at_5": row["recall_at_5"], "recall_at_10": row["recall_at_10"],
                    "mrr": row["mrr"], "ndcg_at_5": row["ndcg_at_5"],
                    "ndcg_at_10": row["ndcg_at_10"],
                    "notes": f"rerank depth sweep d={depth} (bge-reranker-base); "
                             f"p50={row['p50_ms']:.0f}ms p95={row['p95_ms']:.0f}ms",
                })
    finally:
        repaired = sb_rpc("eval_access_snapshot_restore", {})
        print(f"\naccess stats restored ({repaired} rows perturbed by this sweep)")
        lock.__exit__(None, None, None)

    base = next((r for r in table if r["depth"] == 0), None)
    print("\n=== sweep summary ===")
    print(f"{'depth':>6} {'recall@5':>9} {'nDCG@10':>9} {'Δ nDCG':>9} {'p50':>7} {'p95':>7}")
    for r in table:
        d = f"{(r['ndcg_at_10'] - base['ndcg_at_10']):+.4f}" if base else "n/a"
        print(f"{r['depth']:>6} {r['recall_at_5']:>9.3f} {r['ndcg_at_10']:>9.4f} "
              f"{d:>9} {r['p50_ms']:>6.0f}m {r['p95_ms']:>6.0f}m")
    best = max(table, key=lambda r: r["ndcg_at_10"])
    print(f"\nbest nDCG@10: depth {best['depth']} ({best['ndcg_at_10']:.4f}, "
          f"p95 {best['p95_ms']:.0f}ms)")
    return 0


def cmd_gate(args):
    """Regression gate over the trailing median (2026-07-28 research tier 1).

    Why median-of-trailing-N and not diff-vs-last: retrieval scores wobble run to run
    (embedding nondeterminism, corpus growth between runs). Gating on the previous
    single run alarms on noise; gating on the median of the last N absorbs it and
    still catches a real step change. Fires on nDCG@10 specifically because it is the
    metric that moves when ranking degrades without gold falling out of top-k."""
    sel = {"select": "id,tag,created_at,ndcg_at_10,recall_at_5,n_queries,git_sha",
           "order": "created_at.desc", "limit": "1"}
    if args.tag:
        sel["tag"] = f"eq.{args.tag}"
    cur = sb_get("eval_runs", sel)
    if not cur:
        die(f"no eval run found{' tagged ' + args.tag if args.tag else ''}")
    cur = cur[0]
    if cur.get("ndcg_at_10") is None:
        die(f"run {cur['tag']} has no ndcg_at_10 — cannot gate")

    hist = sb_get("eval_runs", {
        "select": "tag,created_at,ndcg_at_10",
        "ndcg_at_10": "not.is.null",
        "created_at": f"lt.{cur['created_at']}",
        "order": "created_at.desc", "limit": str(args.window),
    })
    vals = [h["ndcg_at_10"] for h in hist]
    print(f"gate: run '{cur['tag']}' nDCG@10={cur['ndcg_at_10']:.4f} (n={cur['n_queries']}) "
          f"vs trailing {len(vals)} run(s)")
    if len(vals) < args.min_history:
        print(f"  only {len(vals)} prior run(s) with nDCG (<{args.min_history}) — "
              f"establishing trend, not gating yet")
        return 0

    med = statistics.median(vals)
    floor = med * (1.0 - args.drop_pct / 100.0)
    delta_pct = (cur["ndcg_at_10"] - med) / med * 100.0 if med else 0.0
    print(f"  trailing median {med:.4f} · floor {floor:.4f} (-{args.drop_pct}%) · "
          f"delta {delta_pct:+.1f}%")

    if cur["ndcg_at_10"] < floor:
        msg = (f"🔻 **Memory retrieval regression** — nightly eval `{cur['tag']}`\n"
               f"nDCG@10 **{cur['ndcg_at_10']:.4f}** vs trailing-{len(vals)} median "
               f"{med:.4f} (**{delta_pct:+.1f}%**, floor -{args.drop_pct}%)\n"
               f"recall@5 {cur['recall_at_5']:.3f} · n={cur['n_queries']} · "
               f"git `{(cur.get('git_sha') or 'unknown')[:8]}`\n"
               f"Check what touched the recall path: `hybrid_recall`, RRF weights, "
               f"`trust_weight()`, rerank depth. Trend: "
               f"`python3 eval/retrieval_regression.py trend`")
        print("  REGRESSION — alerting Discord", file=sys.stderr)
        discord(msg)
        return 1

    print("  OK — within tolerance")
    if args.notify_ok:
        discord(f"✅ Nightly memory eval `{cur['tag']}`: nDCG@10 {cur['ndcg_at_10']:.4f} "
                f"({delta_pct:+.1f}% vs median), recall@5 {cur['recall_at_5']:.3f}, "
                f"n={cur['n_queries']}")
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
    r.add_argument("--max-fail-pct", type=float, default=0.05,
                   help="refuse to record the run if more than this fraction of "
                        "retrievals errored (default 0.05) — keeps outage noise out "
                        "of the gate's trailing median")
    r.add_argument("-v", "--verbose", action="store_true")
    r.set_defaults(func=cmd_run)

    t = sub.add_parser("trend", help="show recent runs")
    t.add_argument("--limit", type=int, default=10)
    t.set_defaults(func=cmd_trend)

    s = sub.add_parser("sweep", help="sweep RRF candidate depth into the TEI reranker")
    s.add_argument("--depths", default="0,20,50,100",
                   help="comma-separated candidate depths; 0 = no-rerank control")
    s.add_argument("--tag-prefix", default="rerank-sweep")
    s.add_argument("--git-sha", default=os.environ.get("GIT_SHA"))
    s.add_argument("--record", action="store_true", help="write each depth to eval_runs")
    s.set_defaults(func=cmd_sweep)

    g = sub.add_parser("gate", help="alert if the latest run's nDCG@10 fell below the trailing median")
    g.add_argument("--tag", help="gate this tag's latest run (default: latest run overall)")
    g.add_argument("--window", type=int, default=7, help="trailing runs in the median (default 7)")
    g.add_argument("--drop-pct", type=float, default=5.0, help="alert when nDCG@10 falls this %% below the median")
    g.add_argument("--min-history", type=int, default=3,
                   help="skip gating until this many prior scored runs exist")
    g.add_argument("--notify-ok", action="store_true", help="also post a Discord line when green")
    g.set_defaults(func=cmd_gate)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
