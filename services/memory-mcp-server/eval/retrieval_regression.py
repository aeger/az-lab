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
  FCFR      false-carry-forward rate (migration 084): fraction of 'forgetting'
            probes where a SUPERSEDED memory came back in the top-10. The only
            metric here that measures an absence. Lower is better; 0.0 is target.

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
import re
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


FORGETTING_CATEGORY = "forgetting"
ABSTENTION_CATEGORY = "abstention"

# Default relevance floor for the abstention tier (migration 096).
#
# CALIBRATION, MEASURED 2026-08-01 — this number is a placeholder, not a finding.
#   top hybrid_score, gold AT rank 1   (n=50): min 0.8503  median 1.0263  max 1.0783
#   top hybrid_score, gold NOT at rank1(n=42): min 0.8783  median 1.0070  max 1.0783
#   unanswerable probes reach 1.0651 ("IoT SSID password" -> "Claude Desktop SSH")
# The answerable and unanswerable distributions are indistinguishable, because
# hybrid_score is a fused RANK score, not a calibrated cross-query relevance
# probability. NO floor separates them. The default below is the median top score
# of a correct rank-1 hit — chosen so abstention_rate starts at a value that is
# neither trivially 0 nor trivially 1, and can be re-tuned offline against
# eval_run_results.top_score without re-running anything.
# Treat abstention_rate as an instrument under construction until a calibrated
# signal replaces the floor (top1-vs-top5 margin, or the TEI cross-encoder score,
# which unlike hybrid_score IS query-conditioned).
ABSTENTION_FLOOR = float(os.environ.get("ABSTENTION_FLOOR", "1.0263"))

# Bump whenever the active probe set changes (migration 091). cmd_gate only
# medians over runs sharing this value — nDCG is a mean over the probe
# population, so comparing across probe-set changes measures the change, not a
# regression. Migration 091 added the 13-probe hard tier: 56 -> 69 positives.
# v3 (migration 096, 2026-08-01): +8 abstention probes, +tier column.
# v4 (migration 101, 2026-08-02): +18 AUTHORED hard-tier probes, 3 -> 21. This
# MUST be a version bump, not a silent addition: n_queries goes 79 -> 97 and every
# corpus-wide mean is taken over a different, deliberately harder population, so a
# v3 median compared against a v4 run would report the probe set as a regression.
# Expect the headline numbers to DROP. That is the point — v3's recall@5 was
# bit-identical to fifteen decimals across six runs because nothing could move it.
SCORESET_VERSION = 4

# Below this many hard probes, a hard-tier floor is noise wearing a gate's clothes.
# 096 shipped a tier of 3 that scored n_hard=1 on the night it ran; migration 101
# took it to 21. Raise the floor rather than lower this.
MIN_HARD_TIER_FOR_GATE = 8


def annotate_reachability(rows: list) -> list:
    """Mark which forbidden ids hybrid_recall could actually return.

    WHY (2026-07-30 REC 1): every hybrid_recall lane filters `is_active IS NOT
    FALSE`. A forbidden id whose row is inactive is therefore unreachable BY
    CONSTRUCTION — its probe can never contribute a carry-forward hit, and
    folding it into the FCFR denominator drags the rate toward zero regardless
    of how the ranker behaves. That is exactly how FCFR read 0.0000 on six
    consecutive runs while nobody noticed: 8 of the 9 forgetting probes seeded
    by migration 084 pointed only at superseded (inactive) rows.

    Proven, not assumed — see eval/falsify_fcfr.py, which forces a violation
    through the same score() path and confirms the metric itself is wired."""
    all_ids = sorted({i for r in rows for i in (r.get("forbidden_memory_ids") or [])})
    live = set()
    for i in range(0, len(all_ids), 100):  # keep the URL under PostgREST's limit
        chunk = all_ids[i:i + 100]
        live.update(m["id"] for m in sb_get("memories", {
            "select": "id", "id": f"in.({','.join(chunk)})", "is_active": "not.is.false",
        }))
    for r in rows:
        fids = r.get("forbidden_memory_ids") or []
        r["_reachable_forbidden"] = [i for i in fids if i in live]
    return rows


def load_queries() -> list:
    rows = sb_get("eval_queries", {
        "select": "id,question,topic_hint,gold_memory_ids,forbidden_memory_ids,category,tier",
        "active": "is.true",
        "order": "category,created_at",
    })
    if not rows:
        die("eval_queries is empty — seed it before running (migration 068).")
    return annotate_reachability(rows)


def control_ranking(k: int) -> list:
    """The MemDelta control arm (arXiv 2606.29914, via 2026-07-30 REC 2).

    A ranking that never sees the query: the corpus prior alone — importance,
    then recency. This is what an agent gets with retrieval switched off and
    only "here are the most important recent memories" in context.

    It matters because absolute scores on a self-authored probe set are not
    evidence of anything. Independent evaluation put a plain model with the
    conversation in context at 57.6 on LongMemEval, ahead of most dedicated
    memory systems, while Mem0's OSS edition scored 32.4 against a claimed
    93.4. Recall@5 = 1.0000 tells us nothing on its own; nDCG minus THIS tells
    us whether the six lanes and the reranker earn their latency.

    Query-independent means one fetch serves every probe."""
    rows = sb_get("memories", {
        "select": "id", "is_active": "not.is.false",
        "order": "importance_score.desc.nullslast,last_accessed_at.desc.nullslast,created_at.desc",
        "limit": str(max(k, 10)),
    })
    return [r["id"] for r in rows]


# ── Embedding A/B arm (REC 1, 2026-08-03 research; migration 113) ────────────
# Setting RECALL_FN=hybrid_recall_v2 + EMBED_MODEL=<candidate> scores a candidate
# embedding model against the SAME probes, gold sets, scoring code and reranker
# as the live arm — the only thing that moves is which column the vector lane
# reads and which model produced it. Defaults are the live path, so an unset
# environment reproduces the nightly run exactly.
RECALL_FN = os.environ.get("RECALL_FN", "hybrid_recall")
# Matryoshka truncation width for the candidate arm. Must match the width the
# shadow column was backfilled at, or every query is compared against vectors of
# a different dimensionality and the arm scores as noise.
EMBED_TRUNCATE_DIMS = int(os.environ.get("EMBED_TRUNCATE_DIMS", "0") or 0)


def _fit_dims(vec: list) -> list:
    """MRL-truncate + L2-renormalise, mirroring embed_ab_backfill.py exactly.

    Query and document vectors MUST go through identical post-processing. A
    truncated-but-un-renormalised query against renormalised documents is still
    rank-equivalent under cosine, but the match_threshold cutoff is applied to a
    raw similarity — so an asymmetry here silently changes which rows clear
    p_match_threshold, and that reads as model quality."""
    if not EMBED_TRUNCATE_DIMS or len(vec) <= EMBED_TRUNCATE_DIMS:
        return vec
    out = vec[:EMBED_TRUNCATE_DIMS]
    norm = math.sqrt(sum(x * x for x in out))
    return [x / norm for x in out] if norm else out


# ── Link-expansion backflow (migration 115) ─────────────────────────────────
# Threshold is a CONTRACT shared with src/index.ts's SPREAD_ACTIVATION_THRESHOLD
# and with migration 115's downweight floor. If the TS side raises its threshold
# and this is not raised with it, the probe measures a bar the read path no longer
# uses and reads 0 while leaking.
SPREAD_ACTIVATION_THRESHOLD = float(os.environ.get("SPREAD_ACTIVATION_THRESHOLD", "0.72"))


def backflow_stats() -> dict:
    """Retired memories reachable by recall's spreading-activation step.

    WHY THIS IS NOT COVERED BY FCFR (2026-08-12 research impl 2/3):
      FCFR calls the hybrid_recall RPC directly — see retrieve() below. The bug this
      measures lived ENTIRELY in the TypeScript layer ABOVE that RPC: recall expands
      1-hop links from each top hit and injects up to 5 extra rows that never pass
      through hybrid_recall at all. So every is_active predicate inside the RPC was
      correct, FCFR read clean, and retired rows were still being served — with a
      relevance BOOST, ranked above the live rows that superseded them.

      That is the general lesson worth keeping: a probe that calls the RPC cannot
      see a defect in the code that post-processes the RPC's output. This check
      queries the GRAPH rather than the ranker, so it is blind to that same gap in
      the opposite direction — the two are complements, not substitutes.

    Measured 2026-08-12 before migration 115: 56 reachable edges (74 total) from 15
    active entry points reaching 36 distinct retired rows. After: 0.

    'Reachable' excludes edges whose SOURCE is itself retired — a retired source can
    never appear in recall's top hits, so it can never activate anything.
    """
    rows = sb_rpc("link_backflow_stats", {"p_threshold": SPREAD_ACTIVATION_THRESHOLD})
    return rows[0] if rows else {}


def backflow_falsify() -> dict:
    """Prove the backflow metric can still report a violation.

    backflow_edges SHOULD read 0 forever, which makes it indistinguishable from a
    metric that quietly stopped working — the exact trap FCFR fell into for six runs.
    So every run injects a synthetic violation (active row -> retired row above
    threshold), re-measures, and rolls back.

    Safe to run on the nightly: the injection lives in a plpgsql subtransaction and
    every trigger on memories/memory_links is pure in-transaction (audited 2026-08-12
    — the one pg_net-looking match is a literal 'https?://' regex inside
    extract_facts_from_content, not an outbound call). Nothing survives the rollback.
    """
    rows = sb_rpc("link_backflow_falsify", {})
    return rows[0] if rows else {}


def retrieve(question: str, topic_hint: str, k: int) -> list:
    """The hybrid_recall RPC — the RANKER, not the whole recall path.

    NOT the full MCP recall tool: that tool post-processes this result (staleness
    haircut, rerank, and the link-expansion step that injects up to 5 extra rows).
    Defects in that layer are invisible here by construction — see backflow_stats()
    for one that was live for months behind a clean FCFR.
    """
    emb = _fit_dims(embed(question))
    res = sb_rpc(RECALL_FN, {
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


def score(rows: list, k: int, verbose: bool, control: list = None,
          abstention_floor: float = ABSTENTION_FLOOR):
    """Score every probe, but aggregate the POSITIVE metrics over the non-forgetting
    population only.

    WHY THE SPLIT DENOMINATOR (migration 084): recall@k / MRR / nDCG are means over
    the probe set, so the population IS part of the metric definition. The nightly
    gate (cmd_gate) fires when nDCG@10 falls >5% below the trailing 7-run median —
    folding 9 brand-new probes into that mean would shift it discontinuously at the
    084 boundary and fire an alert attributable to nothing but the schema change.
    That is precisely the unattributable-alarm failure the --max-fail-pct guard
    exists to prevent, so the same reasoning applies here.

    Forgetting probes are still fully scored and still written to eval_run_results
    (their gold_rank and returned_ids are real and worth having); they just do not
    enter the positive aggregate. They get their own metric — FCFR — with its own
    denominator, which keeps both numbers interpretable on their own terms."""
    results, hits1, hits5, hits10, rr_total = [], 0, 0, 0, 0.0
    ndcg5_total, ndcg10_total = 0.0, 0.0
    failures = 0
    n_positive = 0
    n_forgetting = 0
    # Hard tier (migration 096) — probes whose gold currently lands at rank 6-20.
    # Scored as a SUBSET of the positives, not a separate population: they are
    # already inside n_queries, this just reports them on their own so a gain
    # confined to the already-easy probes cannot read as a real improvement.
    n_hard, hard_hits5, hard_ndcg10 = 0, 0, 0.0
    hard_hits1, hard_ndcg5 = 0, 0.0
    # Abstention tier (migration 096) — probes with NO gold row. Excluded from
    # every positive aggregate: their gold set is empty, so rank is always None
    # and folding them in would look like 8 new misses.
    n_abstain, abstain_ok = 0, 0
    abstain_detail = []
    carry_forward_hits = 0
    violations = []
    # Distractor lane — forbidden ids on probes that are NOT supersession tests
    # (migration 101). Reported, deliberately not gated: recall@1 on the hard tier
    # already fails when a distractor outranks gold, and a second gate on the same
    # underlying event would double-count one regression as two.
    n_distractor, distractor_hits = 0, 0
    distractor_violations = []
    # Scorable subset: probes with at least one REACHABLE forbidden id. See
    # annotate_reachability — the blended rate over a mostly-unreachable
    # denominator is what hid the metric for six runs.
    n_forgetting_scorable = 0
    carry_forward_hits_scorable = 0
    # Control arm (query-independent corpus prior), scored over the SAME probes.
    ctrl_hits5, ctrl_ndcg10_total = 0, 0.0

    for q in rows:
        gold = set(q["gold_memory_ids"] or [])
        forbidden = set(q.get("forbidden_memory_ids") or [])
        is_forgetting = q["category"] == FORGETTING_CATEGORY
        is_abstention = q["category"] == ABSTENTION_CATEGORY
        t0 = time.time()
        try:
            # retrieve_rows, not retrieve: the abstention tier needs hybrid_score,
            # and recording top_score for EVERY probe is what lets the relevance
            # floor be re-tuned offline instead of by re-running the harness.
            # Identical RPC call — retrieve() is retrieve_rows() plus a projection.
            rows_out = retrieve_rows(q["question"], q.get("topic_hint"), k)
            returned = [r["id"] for r in rows_out][:k]
        except Exception as e:  # a failed retrieval is a miss, not a crash
            print(f"  ! retrieval failed for {q['id']}: {e}", file=sys.stderr)
            rows_out, returned = [], []
            failures += 1
        latency = int((time.time() - t0) * 1000)
        top_score = rows_out[0].get("hybrid_score") if rows_out else None

        rank = next((i + 1 for i, mid in enumerate(returned) if mid in gold), None)
        nd5, nd10 = ndcg_at(returned, gold, 5), ndcg_at(returned, gold, 10)

        if is_abstention:
            # Correct behaviour is to return NOTHING at or above the floor. A probe
            # that returns rows below the floor still abstains — the caller's
            # relevance cut, not the row count, is what an agent acts on.
            n_abstain += 1
            above = [r for r in rows_out if (r.get("hybrid_score") or 0.0) >= abstention_floor]
            if not above:
                abstain_ok += 1
            abstain_detail.append((q, above[:1], top_score))

        if not is_forgetting and not is_abstention:
            n_positive += 1
            if rank:
                rr_total += 1.0 / rank
                hits1 += rank <= 1
                hits5 += rank <= 5
                hits10 += rank <= 10
            ndcg5_total += nd5
            ndcg10_total += nd10
            if control is not None:
                ctrl_rank = next((i + 1 for i, mid in enumerate(control) if mid in gold), None)
                ctrl_hits5 += bool(ctrl_rank and ctrl_rank <= 5)
                ctrl_ndcg10_total += ndcg_at(control, gold, 10)
            if q.get("tier") == "hard":
                n_hard += 1
                hard_hits5 += bool(rank and rank <= 5)
                hard_ndcg10 += nd10
                # The gate pair (2026-08-02, REC 2). The hard tier is built from
                # near-duplicate distractor clusters, so its characteristic failure
                # is the SIBLING row taking rank 1 with gold right behind it —
                # recall@5 scores that as a hit, recall@1 catches it. nDCG@5 gives
                # the multi-hop probes partial credit for finding one of two golds
                # instead of scoring half an answer as a whole one.
                hard_hits1 += bool(rank and rank <= 1)
                hard_ndcg5 += nd5

        # Negative golds. Scored on the top-10 regardless of k so the number means
        # the same thing across runs with different retrieval depths.
        carried = [m for m in returned[:10] if m in forbidden]
        reachable = set(q.get("_reachable_forbidden") or [])
        if forbidden:
            # FCFR counts SUPERSESSION failures only — "a retired fact reached the
            # top-10, so an agent can answer from it". Migration 101's hard-tier
            # probes also carry forbidden ids, but for a different purpose: the
            # forbidden row there is a near-duplicate DISTRACTOR that is very much
            # still current, just not the answer. Folding those into FCFR would (a)
            # make the alert text ("a retired fact reached the top-10") false, and
            # (b) make its 0.0 ceiling unreachable by construction, since the whole
            # point of a distractor probe is that the distractor is competitive.
            # Distractor carry-forward is already penalised where it belongs: it
            # pushes gold off rank 1, which is exactly what hard_recall_at_1 gates.
            if is_forgetting:
                n_forgetting += 1
                if reachable:
                    n_forgetting_scorable += 1
                if carried:
                    carry_forward_hits += 1
                    if reachable:
                        carry_forward_hits_scorable += 1
                    violations.append((q, carried, returned))
            else:
                n_distractor += 1
                if carried:
                    distractor_hits += 1
                    distractor_violations.append((q, carried, returned))

        results.append({
            "query_id": q["id"], "gold_rank": rank, "hit_at_5": bool(rank and rank <= 5),
            "returned_ids": returned, "latency_ms": latency, "ndcg_at_10": round(nd10, 4),
            "top_score": round(top_score, 6) if top_score is not None else None,
        })
        if verbose:
            if is_abstention:
                mark = "ABSTAINED" if not abstain_detail[-1][1] else "ANSWERED"
                ts = f"{top_score:.4f}" if top_score is not None else "  n/a "
                print(f"  [{q['category']:<10}] {mark:<12} top={ts}  {q['question'][:52]}")
            elif is_forgetting:
                mark = f"CARRY x{len(carried)}" if carried else "clean"
                print(f"  [{q['category']:<10}] {mark:<12} {q['question'][:56]}")
            else:
                mark = f"@{rank}" if rank else "MISS"
                print(f"  [{q['category']:<10}] {mark:<6} nDCG@10={nd10:.2f}  {q['question'][:56]}")

    # A run with zero positive probes would be a corpus/config error, not a 0.0 score.
    if n_positive == 0:
        die("no non-forgetting probes active — refusing to record a run with an "
            "undefined positive-metric denominator")

    metrics = {
        "n_queries": n_positive,
        "recall_at_1": hits1 / n_positive,
        "recall_at_5": hits5 / n_positive,
        "recall_at_10": hits10 / n_positive,
        "mrr": rr_total / n_positive,
        "ndcg_at_5": ndcg5_total / n_positive,
        "ndcg_at_10": ndcg10_total / n_positive,
    }
    # NULL rather than 0.0 when nothing declares negative golds — 0.0 would read as
    # "measured, perfect" when the truth is "not measured".
    metrics["false_carry_forward_rate"] = (
        carry_forward_hits / n_forgetting if n_forgetting else None
    )
    # The number worth gating on. NULL — not 0.0 — when no probe declares a
    # reachable forbidden id, because "not measurable" and "measured, perfect"
    # must not print the same.
    metrics["fcfr_scorable"] = (
        carry_forward_hits_scorable / n_forgetting_scorable if n_forgetting_scorable else None
    )
    metrics["n_forgetting"] = n_forgetting
    metrics["n_forgetting_scorable"] = n_forgetting_scorable
    metrics["n_distractor"] = n_distractor
    metrics["distractor_rate"] = (distractor_hits / n_distractor) if n_distractor else None
    metrics["scoreset_version"] = SCORESET_VERSION

    # Hard tier (migration 096). NULL rather than 0.0 when the tier is empty —
    # "no hard probes" and "hard probes all failed" must not print the same.
    metrics["n_hard"] = n_hard
    metrics["hard_recall_at_5"] = (hard_hits5 / n_hard) if n_hard else None
    metrics["hard_ndcg_at_10"] = (hard_ndcg10 / n_hard) if n_hard else None
    metrics["hard_recall_at_1"] = (hard_hits1 / n_hard) if n_hard else None
    metrics["hard_ndcg_at_5"] = (hard_ndcg5 / n_hard) if n_hard else None

    # Abstention tier (migration 096). Same NULL discipline.
    metrics["n_abstention"] = n_abstain
    metrics["abstention_rate"] = (abstain_ok / n_abstain) if n_abstain else None
    metrics["abstention_floor"] = abstention_floor if n_abstain else None
    if control is not None:
        metrics["recall_at_5_control"] = ctrl_hits5 / n_positive
        metrics["ndcg_at_10_control"] = ctrl_ndcg10_total / n_positive
        metrics["delta_over_no_memory"] = metrics["ndcg_at_10"] - metrics["ndcg_at_10_control"]
    return results, metrics, failures, {"n": n_forgetting, "hits": carry_forward_hits,
                                        "n_scorable": n_forgetting_scorable,
                                        "hits_scorable": carry_forward_hits_scorable,
                                        "violations": violations,
                                        "n_distractor": n_distractor,
                                        "distractor_hits": distractor_hits,
                                        "distractor_violations": distractor_violations,
                                        "abstain_detail": abstain_detail}


def by_category(rows, results):
    cat = {}
    idx = {r["query_id"]: r for r in results}
    for q in rows:
        # Abstention probes have no gold, so hit_at_5 is False by construction.
        # Listing them here would print "abstention 0/8" — a perfect abstention
        # score rendered as total failure. They have their own metric.
        if q["category"] == ABSTENTION_CATEGORY:
            continue
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

        ctrl = None if args.no_control else control_ranking(args.k)
        if ctrl is not None:
            print(f"control arm: {len(ctrl)} corpus-prior rows (query-independent)")

        print(f"Running {len(rows)} eval queries (k={args.k}) against hybrid_recall …")
        try:
            results, m, failures, fcf = score(rows, args.k, args.verbose, control=ctrl,
                                              abstention_floor=args.abstention_floor)
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

    # Link-expansion backflow (migration 115). Query-independent — one call, not one
    # per probe — so it costs nothing to carry on every run. Recorded even when it is
    # zero: the point is that it becomes a SERIES, so a regression shows as a step off
    # a long flat line rather than as a number nobody has a baseline for.
    bf = backflow_stats()
    m["backflow_edges"] = bf.get("reachable_edges")
    # Self-check: a 0 that cannot become non-zero is not a pass, it is a broken gauge.
    bf_falsify = backflow_falsify()

    run = sb_post("eval_runs", {
        "tag": args.tag, "git_sha": args.git_sha,
        "notes": (args.notes or "") + (f" [{failures} retrieval failures]" if failures else ""),
        **m,
    })[0]
    sb_post("eval_run_results", [{"run_id": run["id"], **r} for r in results])

    print(f"\n=== {args.tag} ===")
    print(f"  n          {m['n_queries']}  (positive-gold probes; "
          f"{fcf['n']} forgetting + {m['n_abstention']} abstention probes scored separately)")
    # HEADLINE ORDER IS DELIBERATE (2026-08-01 REC 2). recall@5 has printed
    # 0.835443037974684 on six consecutive runs — bit-identical to 15 decimals
    # across the A/B control AND both treatment arms. Every change so far reorders
    # inside the top 5 without moving anything across the k=5 boundary, so recall@5
    # can detect neither a regression nor an improvement on this scoreset. recall@1
    # and nDCG@5 DO move on exactly those runs (0.5696 -> 0.5823, 0.6950 -> 0.7026).
    # They lead now; recall@5 is demoted and labelled rather than deleted, because
    # the historical series is still worth plotting.
    print(f"  recall@1   {m['recall_at_1']:.3f}   ← sensitive")
    print(f"  nDCG@5     {m['ndcg_at_5']:.3f}   ← sensitive")
    print(f"  nDCG@10    {m['ndcg_at_10']:.3f}   ← gate metric")
    print(f"  MRR        {m['mrr']:.3f}")
    print(f"  recall@5   {m['recall_at_5']:.3f}   (insensitive on this scoreset — do not gate on it)")
    print(f"  recall@10  {m['recall_at_10']:.3f}")
    if m["n_hard"]:
        print(f"  --- hard tier ({m['n_hard']} probes) ---")
        print(f"  recall@1   {m['hard_recall_at_1']:.3f}   <- GATE METRIC")
        print(f"  nDCG@5     {m['hard_ndcg_at_5']:.3f}   <- GATE METRIC")
        print(f"  recall@5   {m['hard_recall_at_5']:.3f}")
        print(f"  nDCG@10    {m['hard_ndcg_at_10']:.3f}")
        if m["n_hard"] < 8:
            print(f"  ! tier holds only {m['n_hard']} probes — too thin to gate on. "
                  f"The 6-20 band is nearly empty because gold is either top-5 or "
                  f"missed outright; a useful hard tier needs AUTHORED probes. "
                  f"Re-mine with: SELECT * FROM eval_hard_tier_candidates;")
    else:
        print("  --- hard tier: EMPTY (no probe currently lands at rank 6-20) ---")
    if "ndcg_at_10_control" in m:
        print(f"  --- MemDelta control arm (retrieval disabled) ---")
        print(f"  recall@5   {m['recall_at_5_control']:.3f}  (corpus prior, no query)")
        print(f"  nDCG@10    {m['ndcg_at_10_control']:.3f}  (corpus prior, no query)")
        print(f"  Δ over no-memory  {m['delta_over_no_memory']:+.3f}  "
              f"← the only number that says retrieval earned its keep")
    if m["false_carry_forward_rate"] is None:
        print("  FCFR       n/a (no probes declare forbidden_memory_ids)")
    else:
        print(f"  FCFR       {m['false_carry_forward_rate']:.3f}  "
              f"({fcf['hits']}/{fcf['n']} probes returned a superseded memory)")
    # The blended FCFR above includes probes whose forbidden rows are inactive and
    # therefore unreachable through any hybrid_recall lane. They cannot fail, so
    # they only drag the rate down. Report the honest denominator alongside it.
    if m["fcfr_scorable"] is None:
        print("  FCFR-live  n/a — NO probe declares a REACHABLE forbidden id, so the "
              "forgetting lane is not being measured at all (see falsify_fcfr.py)")
    else:
        print(f"  FCFR-live  {m['fcfr_scorable']:.3f}  "
              f"({fcf['hits_scorable']}/{fcf['n_scorable']} probes whose forbidden rows "
              f"are still active — the number to gate on)")
        if fcf["n"] > fcf["n_scorable"]:
            print(f"             {fcf['n'] - fcf['n_scorable']} probe(s) vacuous "
                  f"(all forbidden ids is_active=false; retained as an is_active-filter "
                  f"regression test)")
    # Link-expansion backflow (migration 115). Measures the STRUCTURE recall walks,
    # not the ranking it produces — this is the lane FCFR structurally cannot see,
    # because the leak is in the TS layer above the RPC that FCFR calls.
    bf_n = m.get("backflow_edges")
    if bf_n is None:
        print("  BACKFLOW   n/a (link_backflow_stats unavailable — apply migration 115)")
    elif bf_n == 0:
        if bf_falsify.get("detects") is True:
            print(f"  BACKFLOW   0        (no retired row reachable by spreading "
                  f"activation at strength >= {SPREAD_ACTIVATION_THRESHOLD}; "
                  f"falsifier confirms the gauge still moves: "
                  f"{bf_falsify.get('before_edges')}→{bf_falsify.get('after_edges')} "
                  f"on an injected violation)")
        else:
            print(f"  BACKFLOW   0        !! BUT THE GAUGE IS NOT WIRED — an injected "
                  f"violation did NOT move it ({bf_falsify}). This 0 is meaningless. "
                  f"Check link_backflow_stats/link_backflow_falsify (migration 115).")
    else:
        print(f"  BACKFLOW   {bf_n}  !! retired memories are reachable by spreading "
              f"activation — recall can serve a superseded row WITH A RELEVANCE BOOST. "
              f"Check the is_active filter on the linked-memory fetch in src/index.ts "
              f"and migration 115's downweight in supersede_memory.")
    # Abstention (migration 096, REC 5). The ONLY probe class that can catch
    # over-retrieval: every other probe rewards returning something.
    if m["abstention_rate"] is None:
        print("  ABSTAIN    n/a (no abstention probes active)")
    else:
        print(f"  ABSTAIN    {m['abstention_rate']:.3f}  "
              f"({int(m['abstention_rate'] * m['n_abstention'])}/{m['n_abstention']} "
              f"unanswerable probes correctly returned nothing above floor "
              f"{m['abstention_floor']:.4f})")
        print(f"             ! floor is UNCALIBRATED — hybrid_score distributions for "
              f"answerable and unanswerable queries overlap almost completely "
              f"(migration 096). Read this with top_score, not on its own.")
        for q, above, ts in fcf["abstain_detail"]:
            if above:
                print(f"  ! CONFABULATION  {q['question'][:58]}")
                print(f"      answered with \"{above[0]['name'][:52]}\" @ "
                      f"{above[0]['hybrid_score']:.4f}")

    print("  by category (recall@5):")
    for c, v in sorted(by_category(rows, results).items()):
        label = f"{c} *" if c == FORGETTING_CATEGORY else c
        print(f"    {label:<14} {v['hit5']}/{v['n']}  ({v['hit5']/v['n']:.2f})")
    if any(q["category"] == FORGETTING_CATEGORY for q in rows):
        print(f"    (* forgetting probes are excluded from the aggregate above; "
              f"see FCFR)")

    # Distractor lane (migration 101) — over-retrieval on probes that are NOT
    # supersession tests. Reported separately from FCFR because the failure is a
    # different thing: the row returned here is CURRENT, just not the answer.
    if m.get("n_distractor"):
        print(f"  DISTRACTOR {m['distractor_rate']:.3f}  "
              f"({fcf['distractor_hits']}/{fcf['n_distractor']} probes returned a "
              f"near-duplicate they were told not to — over-retrieval, not stale data)")
        print(f"             not gated directly: a distractor outranking gold already "
              f"shows up as a hard-tier recall@1 miss, and gating both would count "
              f"one regression twice.")

    # Name the offenders. An FCFR of 0.111 is not actionable; "probe X returned the
    # v5.9.0 row at rank 3" is.
    for q, carried, returned in fcf["violations"]:
        ranks = ", ".join(f"{m_id[:8]}@{returned.index(m_id) + 1}" for m_id in carried)
        print(f"  ! CARRY-FORWARD  {q['question'][:60]}")
        print(f"      superseded rows returned: {ranks}")
    for q, carried, returned in fcf["distractor_violations"]:
        ranks = ", ".join(f"{m_id[:8]}@{returned.index(m_id) + 1}" for m_id in carried)
        print(f"  ! DISTRACTOR     {q['question'][:60]}")
        print(f"      wrong-but-current rows returned: {ranks}")

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

    # Hard-tier floors — the gate as of 2026-08-02 (research REC 2).
    # Refuse to PASS silently when the tier is too thin to mean anything: a floor
    # applied to a 1-probe tier is a coin flip dressed as a gate, and 096 shipped
    # exactly that (n_hard=1, hard_recall_at_5=0.0000).
    for flag, key, label in (
        (args.fail_under_hard_recall1, "hard_recall_at_1", "hard recall@1"),
        (args.fail_under_hard_ndcg5, "hard_ndcg_at_5", "hard nDCG@5"),
    ):
        if flag is None:
            continue
        if not m["n_hard"]:
            print(f"  FAIL: {label} floor requested but the hard tier is EMPTY — "
                  f"nothing was measured.", file=sys.stderr)
            return 1
        if m["n_hard"] < MIN_HARD_TIER_FOR_GATE:
            print(f"  FAIL: {label} floor requested but the hard tier holds only "
                  f"{m['n_hard']} probe(s); {MIN_HARD_TIER_FOR_GATE} is the minimum "
                  f"for the number to mean anything. Author more probes rather than "
                  f"lowering this.", file=sys.stderr)
            return 1
        if m[key] < flag:
            print(f"  FAIL: {label} {m[key]:.3f} < floor {flag} — a near-duplicate "
                  f"distractor is outranking its gold. Check recall_weights and the "
                  f"trgm/entity lanes before adjusting the floor.", file=sys.stderr)
            return 1

    if args.fail_under_recall1 is not None and m["recall_at_1"] < args.fail_under_recall1:
        print(f"  FAIL: recall@1 {m['recall_at_1']:.3f} < floor {args.fail_under_recall1}", file=sys.stderr)
        return 1

    # Gate on the scorable rate, falling back to the blended one only if no probe
    # declares a reachable forbidden id. Gating on the blended rate would mean
    # gating on a number that 8 of 9 probes are structurally unable to move.
    fcfr = m["fcfr_scorable"] if m["fcfr_scorable"] is not None else m["false_carry_forward_rate"]
    if args.max_fcfr is not None and fcfr is not None and fcfr > args.max_fcfr:
        print(f"  FAIL: false-carry-forward rate {fcfr:.3f} > ceiling {args.max_fcfr} —"
              f"superseded memories are being served. Check the is_active filter on "
              f"every hybrid_recall lane (migration 048b), supersession heuristic (073), "
              f"and trust-tier weighting.", file=sys.stderr)
        return 1

    # Backflow gates at 0 BY DEFAULT, unlike the metrics above. They are quality
    # scores on a self-authored scoreset where the right ceiling is a judgement call;
    # this one is a structural invariant with an unambiguous correct value, and it was
    # measured at 56 before migration 115 rather than assumed to be zero.
    bf_n = m.get("backflow_edges")
    if args.max_backflow is not None and bf_n is not None and bf_n > args.max_backflow:
        print(f"  FAIL: {bf_n} link-expansion backflow edge(s) > ceiling "
              f"{args.max_backflow} — retired memories can re-enter recall through the "
              f"link graph, boosted above the rows that superseded them. See "
              f"migrations/115_link_expansion_backflow_guard.sql.", file=sys.stderr)
        return 1
    # A green backflow reading from a gauge that cannot detect a violation is worse
    # than a red one — it actively asserts safety. Fail on it.
    if args.max_backflow is not None and bf_falsify.get("detects") is not True:
        print(f"  FAIL: the backflow gauge did not detect an INJECTED violation "
              f"({bf_falsify}) — backflow_edges={bf_n} is not evidence of anything. "
              f"Check link_backflow_stats/link_backflow_falsify (migration 115).",
              file=sys.stderr)
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
    emb = _fit_dims(embed(question))
    return sb_rpc(RECALL_FN, {
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
    # Forgetting probes measure an absence and carry no meaningful positive gold for
    # a depth sweep; including them would also make these numbers incomparable to the
    # 2026-07-28 sweep recorded before migration 084.
    rows = [q for q in load_queries() if q["category"] != FORGETTING_CATEGORY]
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


STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "do", "does", "did",
    "of", "for", "to", "in", "on", "at", "and", "or", "but", "with", "from", "by",
    "it", "its", "this", "that", "these", "those", "i", "we", "you", "my", "our",
}
QUESTION_WORDS = {
    "what", "why", "how", "when", "where", "which", "who", "whom", "whose", "should", "can",
}
EXACT_TOKEN_RES = [
    re.compile(r"^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$"),
    re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+){1,}$", re.I),
    re.compile(r"^[a-z0-9]+(_[a-z0-9]+)+$", re.I),
    re.compile(r"^v?\d+\.\d+(\.\d+)?$"),
    re.compile(r"^[A-Z][A-Z0-9_]{2,}$"),
    re.compile(r"^\d{3}$"),
    re.compile(r"^/"),
]


def route_recall(query: str) -> dict:
    """MUST STAY BYTE-EQUIVALENT TO routeRecall() IN src/index.ts.

    Replicated here for the same reason tei_rerank is: measuring the router through
    the MCP server would cost a deploy per iteration, and the thing being validated
    is a pure function of the query string. The hazard is identical too — if this
    drifts from the TypeScript, this harness validates a router production does not
    run. Change both or neither."""
    q = (query or "").strip()
    default = {"mode": "hybrid", "rerank": True, "pool": 2, "reason": "default (fail-open)"}
    if not q:
        return {**default, "reason": "empty query — fail-open"}

    tokens = [t for t in q.split() if t]
    lower = [t.lower() for t in tokens]
    has_stopword = any(t in STOPWORDS for t in lower)
    has_question_word = any(t in QUESTION_WORDS for t in lower)
    multi_clause = bool(re.search(r"[,;?]|\band\b|\bor\b|\bbut\b", q, re.I))

    if len(tokens) <= 4 and not has_stopword and not has_question_word:
        exact = [t for t in tokens
                 if any(r.match(re.sub(r"[.,;:?!]+$", "", t)) for r in EXACT_TOKEN_RES)]
        if exact and len(exact) == len(tokens):
            return {"mode": "lexical", "rerank": False, "pool": 2,
                    "reason": f"exact-token ({len(tokens)} tok)"}

    if len(tokens) <= 8 and has_stopword and not multi_clause and not has_question_word:
        return {"mode": "hybrid", "rerank": False, "pool": 2,
                "reason": f"short factual NL ({len(tokens)} tok)"}

    if len(tokens) > 8 or multi_clause or has_question_word:
        return {"mode": "hybrid", "rerank": True, "pool": 4,
                "reason": f"verbose/interrogative NL ({len(tokens)} tok)"}

    return default


def retrieve_routed(question: str, topic_hint: str, k: int, route: dict) -> list:
    """Replicates the MCP recall path for a given route: mode selects which lanes
    hybrid_recall sees (lexical => null embedding; semantic => blank query_text and
    no topic_hint), pool widens p_match_count, rerank runs TEI over the top 20."""
    wants_vector = route["mode"] != "lexical"
    wants_lexical = route["mode"] != "semantic"

    emb = _fit_dims(embed(question)) if wants_vector else None
    body = {
        "p_query_text": question if wants_lexical else " ",
        "p_query_embedding": json.dumps(emb) if emb else None,
        "p_match_threshold": 0.3 if emb else 0.0,
        "p_match_count": k * route["pool"],
    }
    if wants_lexical and topic_hint:
        body["p_topic_hint"] = topic_hint
    rows = sb_rpc(RECALL_FN, body)

    if route["rerank"] and len(rows) > 1:
        pool = rows[:20]
        rows = tei_rerank(question, pool) + rows[20:]
    return [r["id"] for r in rows][:k]


def cmd_router(args):
    """A/B the adaptive recall router (2026-07-26 research, tier 1).

    Arm OFF reproduces today's production behaviour: hybrid, pool x2, rerank always.
    Arm ON routes per query. Accept the router ONLY if nDCG@10 holds and latency drops
    — a router that trades recall for speed is a silent regression, which is why the
    decision line below prints both and refuses to summarise them into one score."""
    rows = [q for q in load_queries() if q["category"] != FORGETTING_CATEGORY]
    off_route = {"mode": "hybrid", "rerank": True, "pool": 2, "reason": "flag-off control"}

    # Show the routing distribution before spending any latency on it — if the probe
    # set does not contain the query shapes the router discriminates on, the A/B
    # cannot show a difference and that is a fact about the PROBE SET, not the router.
    dist = {}
    for q in rows:
        r = route_recall(q["question"])
        key = f"{r['mode']}/rerank={r['rerank']}/pool=x{r['pool']}"
        dist[key] = dist.get(key, 0) + 1
    print("routing distribution over probe set:")
    for key, n in sorted(dist.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>3}  {key}")
    print()

    results = {}
    with eval_lock("router A/B"):
        snapped = sb_rpc("eval_access_snapshot_take", {})
        print(f"access-stat snapshot taken ({snapped} rows) — A/B will be non-mutating\n")
        try:
            for arm in ("off", "on"):
                hits5 = 0
                nd10_t = 0.0
                lats = []
                for q in rows:
                    route = off_route if arm == "off" else route_recall(q["question"])
                    gold = set(q["gold_memory_ids"] or [])
                    t0 = time.time()
                    try:
                        returned = retrieve_routed(q["question"], q.get("topic_hint"),
                                                   args.k, route)
                    except Exception as e:
                        print(f"  ! arm={arm} {q['id']}: {e}", file=sys.stderr)
                        returned = []
                    lats.append((time.time() - t0) * 1000)
                    rank = next((i + 1 for i, m in enumerate(returned) if m in gold), None)
                    if rank:
                        hits5 += rank <= 5
                    nd10_t += ndcg_at(returned, gold, 10)
                lats.sort()
                results[arm] = {
                    "recall_at_5": hits5 / len(rows),
                    "ndcg_at_10": nd10_t / len(rows),
                    "p50_ms": lats[len(lats) // 2],
                    "p95_ms": lats[int(len(lats) * 0.95) - 1],
                    "total_s": sum(lats) / 1000.0,
                }
                r = results[arm]
                print(f"  RECALL_ROUTER={'1' if arm == 'on' else '0'}: "
                      f"recall@5 {r['recall_at_5']:.3f}  nDCG@10 {r['ndcg_at_10']:.4f}  "
                      f"p50 {r['p50_ms']:.0f}ms  p95 {r['p95_ms']:.0f}ms  "
                      f"total {r['total_s']:.1f}s")
        finally:
            repaired = sb_rpc("eval_access_snapshot_restore", {})
            print(f"\naccess stats restored ({repaired} rows perturbed by this A/B)")

    off, on = results["off"], results["on"]
    d_ndcg = on["ndcg_at_10"] - off["ndcg_at_10"]
    d_ndcg_pct = (d_ndcg / off["ndcg_at_10"] * 100) if off["ndcg_at_10"] else 0.0
    d_p50_pct = (on["p50_ms"] - off["p50_ms"]) / off["p50_ms"] * 100 if off["p50_ms"] else 0.0

    print("\n=== router A/B verdict ===")
    print(f"  nDCG@10  {off['ndcg_at_10']:.4f} -> {on['ndcg_at_10']:.4f}  "
          f"({d_ndcg:+.4f}, {d_ndcg_pct:+.1f}%)")
    print(f"  recall@5 {off['recall_at_5']:.3f} -> {on['recall_at_5']:.3f}")
    print(f"  p50      {off['p50_ms']:.0f}ms -> {on['p50_ms']:.0f}ms ({d_p50_pct:+.1f}%)")
    print(f"  p95      {off['p95_ms']:.0f}ms -> {on['p95_ms']:.0f}ms")

    quality_holds = d_ndcg >= -args.tolerance
    latency_drops = on["p50_ms"] < off["p50_ms"]
    if quality_holds and latency_drops:
        print("\n  SHIP: quality held and latency dropped.")
        return 0
    if not quality_holds:
        print(f"\n  DO NOT SHIP: nDCG@10 fell {d_ndcg:+.4f} (tolerance -{args.tolerance}). "
              f"A misroute is a silent recall miss.", file=sys.stderr)
        return 1
    print("\n  DO NOT SHIP (no benefit): quality held but latency did not drop. "
          "Leave RECALL_ROUTER=0 — untaken complexity is cheaper than taken complexity.",
          file=sys.stderr)
    return 1


def cmd_gate(args):
    """Regression gate over the trailing median (2026-07-28 research tier 1).

    Why median-of-trailing-N and not diff-vs-last: retrieval scores wobble run to run
    (embedding nondeterminism, corpus growth between runs). Gating on the previous
    single run alarms on noise; gating on the median of the last N absorbs it and
    still catches a real step change. Fires on nDCG@10 specifically because it is the
    metric that moves when ranking degrades without gold falling out of top-k."""
    sel = {"select": "id,tag,created_at,ndcg_at_10,recall_at_5,recall_at_1,ndcg_at_5,"
                     "n_queries,git_sha,"
                     "false_carry_forward_rate,fcfr_scorable,n_forgetting_scorable,"
                     "ndcg_at_10_control,delta_over_no_memory,scoreset_version,"
                     "n_hard,hard_ndcg_at_10,n_abstention,abstention_rate,abstention_floor",
           "order": "created_at.desc", "limit": "1"}
    if args.tag:
        sel["tag"] = f"eq.{args.tag}"
    cur = sb_get("eval_runs", sel)
    if not cur:
        die(f"no eval run found{' tagged ' + args.tag if args.tag else ''}")
    cur = cur[0]
    if cur.get("ndcg_at_10") is None:
        die(f"run {cur['tag']} has no ndcg_at_10 — cannot gate")

    # Median only over runs that scored the SAME probe set (migration 091).
    # nDCG is a mean over the probe population, so the population is part of the
    # metric definition: medianing across a probe-set change compares two
    # different metrics and alerts on the change itself. Migration 084 dodged
    # this once with a split denominator; scoreset_version makes it structural.
    ssv = cur.get("scoreset_version") or 1
    hist = sb_get("eval_runs", {
        "select": "tag,created_at,ndcg_at_10",
        "ndcg_at_10": "not.is.null",
        "scoreset_version": f"eq.{ssv}",
        "created_at": f"lt.{cur['created_at']}",
        "order": "created_at.desc", "limit": str(args.window),
    })
    vals = [h["ndcg_at_10"] for h in hist]
    print(f"gate: run '{cur['tag']}' nDCG@10={cur['ndcg_at_10']:.4f} (n={cur['n_queries']}, "
          f"scoreset v{ssv}) vs trailing {len(vals)} run(s) on the same probe set")
    if len(vals) < args.min_history:
        print(f"  only {len(vals)} prior run(s) with nDCG on scoreset v{ssv} "
              f"(<{args.min_history}) — establishing trend, not gating yet")
        if args.notify_ok:
            discord(_ok_line(cur, None, vals, ssv) +
                    f"\n_establishing trend on scoreset v{ssv} "
                    f"({len(vals)}/{args.min_history} prior runs) — not gating yet_")
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
               # recall@1 + nDCG@5, not recall@5 (2026-08-01 REC 2): recall@5 has
               # been bit-identical across six runs, so quoting it next to a
               # regression tells the reader nothing about what moved.
               f"recall@1 {cur['recall_at_1']:.3f} · nDCG@5 {cur['ndcg_at_5']:.3f} · "
               f"n={cur['n_queries']} · git `{(cur.get('git_sha') or 'unknown')[:8]}`\n"
               f"Check what touched the recall path: `hybrid_recall`, RRF weights, "
               f"`trust_weight()`, rerank depth. Trend: "
               f"`python3 eval/retrieval_regression.py trend`")
        print("  REGRESSION — alerting Discord", file=sys.stderr)
        discord(msg)
        return 1

    print("  OK — within tolerance")

    # FCFR is gated separately from nDCG, not folded into it. A superseded memory
    # reaching the top-10 is a correctness failure at ANY level — there is no
    # trailing median to be "within tolerance" of, so it gets an absolute ceiling.
    #
    # Gate the SCORABLE rate (migration 091). The blended rate averages in probes
    # whose forbidden rows are inactive and therefore unreachable through any
    # hybrid_recall lane; those probes cannot fail, so they only push the rate
    # toward zero. That dilution is precisely why FCFR read 0.0000 for six runs
    # while the lane was never actually exercised.
    fcfr = cur.get("fcfr_scorable")
    if fcfr is None and cur.get("n_forgetting_scorable") == 0:
        print("  ! forgetting lane NOT MEASURED — no probe declares a reachable "
              "forbidden id (run eval/falsify_fcfr.py --audit-only)", file=sys.stderr)
    if fcfr is not None:
        print(f"  false-carry-forward (scorable) {fcfr:.3f} over "
              f"{cur.get('n_forgetting_scorable')} probe(s) (ceiling {args.max_fcfr})")
        if fcfr > args.max_fcfr:
            discord(f"🔻 **Superseded memories are being served** — eval `{cur['tag']}`\n"
                    f"false-carry-forward rate **{fcfr:.3f}** > ceiling {args.max_fcfr}. "
                    f"A retired fact reached the top-10, so agents can answer from it.\n"
                    f"Check: `is_active` filter on all six `hybrid_recall` lanes "
                    f"(migration 048b), supersession heuristic (073), trust-tier weight.")
            print("  FCFR CEILING BREACHED — alerting Discord", file=sys.stderr)
            return 1

    if args.notify_ok:
        discord(_ok_line(cur, delta_pct, vals, ssv))
    return 0


def _ok_line(cur: dict, delta_pct, vals: list, ssv: int) -> str:
    """The green nightly line.

    2026-07-30 REC 1 asked for the forgetting lane to be VISIBLE alongside
    Recall@5, and REC 2 for delta-over-no-memory. Both are here, and both say
    "not measured" out loud when they are not measured — a silent metric is how
    FCFR sat at 0.0000 for six runs without anyone asking why."""
    vs = f" ({delta_pct:+.1f}% vs median of {len(vals)})" if delta_pct is not None else ""
    fcfr, n_sc = cur.get("fcfr_scorable"), cur.get("n_forgetting_scorable")
    if fcfr is not None:
        forget = f"forgetting {fcfr:.3f} over {n_sc} live probe(s)"
    elif n_sc == 0:
        forget = "forgetting **NOT MEASURED** (no reachable forbidden ids)"
    else:
        forget = "forgetting n/a"
    d = cur.get("delta_over_no_memory")
    ctrl = (f"Δ over no-memory **{d:+.3f}** (control nDCG@10 "
            f"{cur.get('ndcg_at_10_control'):.3f})") if d is not None else "no control arm"
    # 2026-08-01 REC 2: recall@5 is off the green line. It printed the identical
    # float on six consecutive runs including both A/B arms, so as a daily status
    # signal it conveyed nothing. recall@1 and nDCG@5 move on the same runs.
    ar = cur.get("abstention_rate")
    if ar is not None:
        n_ab = cur.get("n_abstention") or 0
        abstain = (f"abstention {ar:.3f} over {n_ab} probe(s) "
                   f"@floor {cur.get('abstention_floor'):.3f} _(uncalibrated)_")
    else:
        abstain = "abstention **NOT MEASURED** (no unanswerable probes)"
    nh = cur.get("n_hard") or 0
    hard = (f"hard tier {cur['hard_ndcg_at_10']:.3f} over {nh} probe(s)"
            if cur.get("hard_ndcg_at_10") is not None else "hard tier empty")
    return (f"✅ Nightly memory eval `{cur['tag']}` (scoreset v{ssv})\n"
            f"nDCG@10 {cur['ndcg_at_10']:.4f}{vs} · recall@1 {cur['recall_at_1']:.3f} · "
            f"nDCG@5 {cur['ndcg_at_5']:.3f} · n={cur['n_queries']}\n"
            f"{ctrl} · {forget}\n{hard} · {abstain}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run the eval set and record a run")
    r.add_argument("--tag", required=True)
    r.add_argument("--k", type=int, default=10, help="retrieval depth (recall@10 needs >=10)")
    r.add_argument("--compare", help="prior run tag to diff against")
    r.add_argument("--tolerance", type=float, default=0.02, help="allowed recall@5 drop vs --compare")
    r.add_argument("--fail-under-recall5", type=float, default=None,
                   help="DEPRECATED (2026-08-01 REC 2) — recall@5 is insensitive on this "
                        "scoreset; prefer --fail-under-recall1")
    r.add_argument("--fail-under-hard-recall1", type=float, default=None,
                   help="fail when tier=hard recall@1 falls below this. THE gate as of "
                        "2026-08-02 — the hard tier is distractor-based, so its failure "
                        "mode is the sibling row at rank 1, which recall@5 cannot see")
    r.add_argument("--fail-under-hard-ndcg5", type=float, default=None,
                   help="fail when tier=hard nDCG@5 falls below this. Companion gate: "
                        "gives partial credit on multi-gold multi-hop probes")
    r.add_argument("--fail-under-recall1", type=float, default=None,
                   help="hard floor for CI on recall@1, which actually moves")
    r.add_argument("--abstention-floor", type=float, default=ABSTENTION_FLOOR,
                   help="hybrid_score at or above which a returned row counts as "
                        "'answered' for the abstention tier (migration 096; UNCALIBRATED)")
    r.add_argument("--max-fcfr", type=float, default=None,
                   help="hard ceiling on the false-carry-forward rate (migration 084). "
                        "Fails the run when superseded memories reach the top-10. "
                        "Not on by default — establish a baseline before gating.")
    r.add_argument("--max-backflow", type=int, default=0,
                   help="hard ceiling on link-expansion backflow edges (migration 115). "
                        "Defaults to 0 and IS on by default, unlike the quality gates: "
                        "a retired row reachable through the link graph is a structural "
                        "defect with an unambiguous correct value, not a tuning choice. "
                        "Pass a higher value only to record a known-bad baseline.")
    r.add_argument("--git-sha", default=os.environ.get("GIT_SHA"))
    r.add_argument("--no-control", action="store_true",
                   help="skip the MemDelta control arm (migration 091). The control "
                        "is one extra query, not one extra retrieval per probe — "
                        "there is rarely a reason to skip it.")
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

    rt = sub.add_parser("router", help="A/B the adaptive recall router (RECALL_ROUTER)")
    rt.add_argument("--k", type=int, default=10)
    rt.add_argument("--tolerance", type=float, default=0.02,
                    help="max allowed nDCG@10 drop for the router to be shippable")
    rt.set_defaults(func=cmd_router)

    g = sub.add_parser("gate", help="alert if the latest run's nDCG@10 fell below the trailing median")
    g.add_argument("--tag", help="gate this tag's latest run (default: latest run overall)")
    g.add_argument("--window", type=int, default=7, help="trailing runs in the median (default 7)")
    g.add_argument("--drop-pct", type=float, default=5.0, help="alert when nDCG@10 falls this %% below the median")
    g.add_argument("--min-history", type=int, default=3,
                   help="skip gating until this many prior scored runs exist")
    g.add_argument("--max-fcfr", type=float, default=0.0,
                   help="absolute ceiling on false-carry-forward rate (default 0.0 — "
                        "any superseded memory in the top-10 alerts). Not medianed: "
                        "serving a retired fact is wrong at any baseline.")
    g.add_argument("--notify-ok", action="store_true", help="also post a Discord line when green")
    g.set_defaults(func=cmd_gate)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
