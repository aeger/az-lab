#!/usr/bin/env python3
"""
Ranker tuning sweep — the dedicated pass migration 086 was waiting on.

WHY THIS EXISTS
  retrieval_regression.py answers "did this change help?" for ONE configuration.
  It re-embeds all 65 probes per run and writes an eval_runs row, so it is the
  wrong shape for trying twenty weight vectors: twenty runs is twenty embedding
  passes and twenty rows of noise in the trend line the nightly gate medians over.

  This script embeds each probe ONCE, caches the vectors on disk, and then replays
  them against hybrid_recall for every candidate configuration by UPDATEing
  public.recall_weights between passes (migration 086 moved the weights out of the
  function body precisely so this would not need a DDL round trip per config).
  It records nothing to eval_runs. Use retrieval_regression.py to certify the
  winner; use this to find it.

THE ACCESS-COUNT TRAP
  hybrid_recall bumps access_count / recall_count / last_accessed on every row it
  returns, and three of the six composite terms read exactly those columns. Left
  alone, config #7 would be scored against a corpus that configs #1-6 had already
  promoted -- the sweep would measure its own history. The snapshot is therefore
  restored after EVERY config, not once at the end.

USAGE
  python3 tune_ranker.py sweep --stage relevance
  python3 tune_ranker.py sweep --stage trgm --relevance 0.60
  python3 tune_ranker.py sweep --grid custom.json
  python3 tune_ranker.py apply --name rel-0.60 --stage relevance
  python3 tune_ranker.py show
"""
import argparse
import json
import sys
import time
from pathlib import Path

import retrieval_regression as rr  # env loading, embed(), sb_*(), ndcg_at(), eval_lock()

CACHE = Path(__file__).resolve().parent / ".probe_embeddings.json"
RESULTS = Path(__file__).resolve().parent / "results" / "tuning"

# Baseline non-relevance shares, from the pre-086 composite:
#   0.25 recency + 0.20 access + 0.15 novelty + 0.25 importance + 0.10 recall_count
# = 0.95 of prior mass alongside 0.15 relevance, total 1.10.
PRIOR = {"recency": 0.25, "access": 0.20, "novelty": 0.15, "importance": 0.25,
         "recall_count": 0.10}
PRIOR_TOTAL = sum(PRIOR.values())
TOTAL = 1.10

KEYS = ["w_recency", "w_access", "w_novelty", "w_importance", "w_relevance",
        "w_recall_count", "w_lane_trgm", "trgm_floor"]


def cfg(relevance, trgm_floor=0.05, w_lane_trgm=0.5, **overrides):
    """Hold the total constant and rescale the priors proportionally.

    Keeping the sum at 1.10 means hybrid_score stays on the scale every consumer
    (the dashboard, the MCP layer's confidence display, memory_health_report) has
    calibrated against. Only the BALANCE moves.
    """
    s = (TOTAL - relevance) / PRIOR_TOTAL
    c = {f"w_{k}": round(v * s, 4) for k, v in PRIOR.items()}
    c["w_relevance"] = relevance
    c["trgm_floor"] = trgm_floor
    c["w_lane_trgm"] = w_lane_trgm
    c.update(overrides)
    return c


def stage_relevance():
    """How much of the score should relevance be? Everything else held fixed."""
    grid = [(f"rel-{r:.2f}", cfg(r)) for r in
            (0.15, 0.30, 0.45, 0.60, 0.75, 0.90)]
    # The pre-086 configuration, for reference. Note it is NOT the pre-086
    # BEHAVIOUR -- 086 also un-gated the trgm lane and replaced the saturating
    # rrf/0.033 term with per-query normalisation. This row isolates the weights.
    grid.insert(0, ("pre086-weights", cfg(0.15)))
    return grid


def stage_shape(relevance):
    """At the chosen relevance level, which priors are actually earning their keep?"""
    base = cfg(relevance)
    out = [("shape-proportional", base)]
    for drop in ("access", "novelty", "recall_count", "recency"):
        c = dict(base)
        freed = c[f"w_{drop}"]
        c[f"w_{drop}"] = 0.0
        # Give the freed mass to importance, the one prior with a human in the loop.
        c["w_importance"] = round(c["w_importance"] + freed, 4)
        out.append((f"shape-no-{drop}", c))
    # Popularity priors off entirely; importance + recency retained.
    c = dict(base)
    freed = c["w_access"] + c["w_recall_count"] + c["w_novelty"]
    c["w_access"] = c["w_recall_count"] = c["w_novelty"] = 0.0
    c["w_importance"] = round(c["w_importance"] + freed * 0.6, 4)
    c["w_recency"] = round(c["w_recency"] + freed * 0.4, 4)
    out.append(("shape-no-popularity", c))
    return out


def stage_trgm(relevance, shape=None):
    """Is the un-gated trigram lane helping, and at what floor?

    floor=2.0 is unreachable (similarity maxes at 1.0), so that row is the lane
    switched OFF -- a cleaner ablation than re-adding the gate.
    """
    base = dict(shape) if shape else cfg(relevance)
    out = []
    for floor in (2.0, 0.02, 0.05, 0.12, 0.25, 0.40):
        c = dict(base)
        c["trgm_floor"] = floor
        out.append((f"trgm-off" if floor > 1.0 else f"trgm-{floor:.2f}", c))
    for w in (0.3, 0.8, 1.2):
        c = dict(base)
        c["w_lane_trgm"] = w
        out.append((f"trgmw-{w:.1f}", c))
    return out


# ---------------------------------------------------------------------------


LEAK_THRESHOLD = 0.55


def _trigrams(t):
    """pg_trgm's trigram set: lowercase, split on non-alphanumerics, pad each word
    with two leading and one trailing space. Reimplemented rather than round-tripped
    to the DB so the leakage flag uses EXACTLY the measure the trgm lane uses."""
    import re
    out = set()
    for w in re.split(r"[^a-z0-9]+", t.lower()):
        if not w:
            continue
        p = "  " + w + " "
        out.update(p[i:i + 3] for i in range(len(p) - 2))
    return out


def trgm_similarity(a, b):
    ta, tb = _trigrams(a), _trigrams(b)
    return len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0


def mark_leaky(rows):
    """Flag probes whose topic_hint is a near-copy of a gold memory's NAME.

    This matters because 086 lets the trigram lane probe with topic_hint, and for
    those probes topic_hint IS effectively the answer key -- trigram(name, hint)
    ~ 1.0 by construction, not by retrieval skill. Measured over the active probe
    set on 2026-07-28, mean similarity(gold name, topic_hint) by category:
    mined_high_recall 0.874 (17/18 over threshold) -- the circularity that set was
    already known to have -- but also single_hop 0.484 (7/23) and temporal 0.478
    (5/10). The "honest" categories are not automatically clean.

    Every metric below is reported twice: over all probes, and over the clean
    subset. Tune on the clean number. A configuration that only wins on the leaky
    subset has learned the dataset's construction, not the corpus.
    """
    gold_ids = sorted({g for q in rows for g in (q["gold_memory_ids"] or [])})
    names = {}
    for i in range(0, len(gold_ids), 100):
        chunk = gold_ids[i:i + 100]
        names.update({m["id"]: m["name"] for m in rr.sb_get(
            "memories", {"select": "id,name", "id": "in.(" + ",".join(chunk) + ")"})})
    for q in rows:
        hint = q.get("topic_hint") or ""
        best = max((trgm_similarity(hint, names.get(g) or "")
                    for g in (q["gold_memory_ids"] or []) if hint), default=0.0)
        q["_leaky"] = best >= LEAK_THRESHOLD
    n = sum(1 for q in rows if q["_leaky"])
    print(f"topic_hint leakage: {n}/{len(rows)} probes have a hint whose trigram "
          f"similarity to a gold NAME is >= {LEAK_THRESHOLD}")
    return rows


def load_embeddings(rows, refresh=False):
    cache = {}
    if CACHE.exists() and not refresh:
        cache = json.loads(CACHE.read_text())
    missing = [q for q in rows if q["id"] not in cache]
    if missing:
        print(f"embedding {len(missing)} probe(s) (cached: {len(cache)}) …")
        for q in missing:
            cache[q["id"]] = rr.embed(q["question"])
        CACHE.write_text(json.dumps(cache))
    return cache


def set_weights(c):
    body = {k: c[k] for k in KEYS}
    body["updated_at"] = "now()"
    r = rr.httpx.patch(f"{rr.SUPABASE_URL}/rest/v1/recall_weights?id=eq.true",
                       headers={**rr.SB_HEADERS, "Prefer": "return=representation"},
                       json={k: c[k] for k in KEYS}, timeout=30)
    r.raise_for_status()


def read_weights():
    return rr.sb_get("recall_weights", {"select": "*", "id": "eq.true"})[0]


def run_config(rows, embs, k=10):
    """One full pass over the probe set. Same metric definitions as
    retrieval_regression.score() -- positive metrics over non-forgetting probes
    only, FCFR on its own denominator (migration 084)."""
    hits1 = hits5 = hits10 = 0
    rr_total = nd5_total = nd10_total = 0.0
    n_pos = n_forget = carried_probes = 0
    clean_n = clean_hits5 = 0
    clean_nd10 = 0.0
    per_cat = {}
    lat = []
    for q in rows:
        gold = set(q["gold_memory_ids"] or [])
        forbidden = set(q.get("forbidden_memory_ids") or [])
        is_forget = q["category"] == rr.FORGETTING_CATEGORY
        t0 = time.time()
        res = rr.sb_rpc("hybrid_recall", {
            "p_query_text": q["question"],
            "p_query_embedding": json.dumps(embs[q["id"]]),
            "p_match_threshold": 0.3,
            "p_match_count": k,
            "p_topic_hint": q.get("topic_hint"),
        })
        lat.append((time.time() - t0) * 1000)
        returned = [r["id"] for r in res][:k]
        rank = next((i + 1 for i, mid in enumerate(returned) if mid in gold), None)
        c = per_cat.setdefault(q["category"], {"n": 0, "hit5": 0})
        c["n"] += 1
        c["hit5"] += bool(rank and rank <= 5)
        if not is_forget:
            n_pos += 1
            if rank:
                rr_total += 1.0 / rank
                hits1 += rank <= 1
                hits5 += rank <= 5
                hits10 += rank <= 10
            nd5_total += rr.ndcg_at(returned, gold, 5)
            nd10_total += rr.ndcg_at(returned, gold, 10)
            if not q.get("_leaky"):
                clean_n += 1
                clean_hits5 += bool(rank and rank <= 5)
                clean_nd10 += rr.ndcg_at(returned, gold, 10)
        if forbidden:
            n_forget += 1
            carried_probes += any(m in forbidden for m in returned[:10])
    return {
        "recall_at_1": hits1 / n_pos, "recall_at_5": hits5 / n_pos,
        "recall_at_10": hits10 / n_pos, "mrr": rr_total / n_pos,
        "ndcg_at_5": nd5_total / n_pos, "ndcg_at_10": nd10_total / n_pos,
        "fcfr": (carried_probes / n_forget) if n_forget else None,
        "clean_n": clean_n,
        "clean_recall_at_5": (clean_hits5 / clean_n) if clean_n else None,
        "clean_ndcg_at_10": (clean_nd10 / clean_n) if clean_n else None,
        "p50_ms": sorted(lat)[len(lat) // 2],
        "by_cat": {c: v["hit5"] / v["n"] for c, v in sorted(per_cat.items())},
    }


def build_grid(args):
    if args.grid:
        return [(c["name"], {k: c[k] for k in KEYS}) for c in json.loads(Path(args.grid).read_text())]
    if args.stage == "relevance":
        return stage_relevance()
    if args.stage == "shape":
        return stage_shape(args.relevance)
    if args.stage == "trgm":
        shape = json.loads(Path(args.shape).read_text()) if args.shape else None
        return stage_trgm(args.relevance, shape)
    rr.die(f"unknown stage {args.stage}")


def cmd_sweep(args):
    rows = mark_leaky(rr.load_queries())
    embs = load_embeddings(rows, args.refresh_embeddings)
    grid = build_grid(args)
    original = read_weights()
    print(f"sweeping {len(grid)} configs x {len(rows)} probes …")

    out = []
    with rr.eval_lock(f"tune_ranker sweep --stage {args.stage}"):
        snapped = rr.sb_rpc("eval_access_snapshot_take", {})
        print(f"access-stat snapshot taken ({snapped} rows)")
        try:
            for name, c in grid:
                set_weights(c)
                m = run_config(rows, embs, args.k)
                # Restore BETWEEN configs, not just at the end -- otherwise each
                # config inherits the access-count promotions of its predecessors.
                rr.sb_rpc("eval_access_snapshot_restore", {})
                m["name"], m["config"] = name, c
                out.append(m)
                print(f"  {name:<22} nDCG@10 {m['ndcg_at_10']:.3f}  "
                      f"R@5 {m['recall_at_5']:.3f}  "
                      f"| clean nDCG@10 {m['clean_ndcg_at_10']:.3f} "
                      f"R@5 {m['clean_recall_at_5']:.3f}  "
                      f"| MRR {m['mrr']:.3f} FCFR {m['fcfr']} p50 {m['p50_ms']:.0f}ms")
        finally:
            set_weights(original)
            rr.sb_rpc("eval_access_snapshot_restore", {})
            print("weights and access stats restored")

    # Ranked by the LEAKAGE-CONTROLLED number. See mark_leaky().
    out.sort(key=lambda r: -r["clean_ndcg_at_10"])
    print(f"\n=== stage {args.stage} — ranked by clean nDCG@10 (n={out[0]['clean_n']}) ===")
    cats = sorted({c for r in out for c in r["by_cat"]})
    print(f"  {'config':<22} {'cln@10':>7} {'clnR@5':>7} {'nDCG@10':>8} {'R@5':>6} {'MRR':>6} "
          + " ".join(f"{c[:9]:>9}" for c in cats))
    for r in out:
        print(f"  {r['name']:<22} {r['clean_ndcg_at_10']:>7.3f} {r['clean_recall_at_5']:>7.3f} "
              f"{r['ndcg_at_10']:>8.3f} {r['recall_at_5']:>6.3f} {r['mrr']:>6.3f} "
              + " ".join(f"{r['by_cat'].get(c, 0):>9.2f}" for c in cats))

    RESULTS.mkdir(parents=True, exist_ok=True)
    dest = RESULTS / f"{args.stage}.json"
    dest.write_text(json.dumps(out, indent=2))
    best = RESULTS / f"{args.stage}-best.json"
    best.write_text(json.dumps(out[0]["config"], indent=2))
    print(f"\nwrote {dest}\nbest config -> {best}")
    return 0


def cmd_apply(args):
    src = json.loads((RESULTS / f"{args.stage}.json").read_text())
    hit = next((r for r in src if r["name"] == args.name), None)
    if not hit:
        rr.die(f"no config named {args.name} in stage {args.stage}")
    set_weights(hit["config"])
    print(f"applied {args.name}: {json.dumps(hit['config'])}")
    print("NOW RUN: python3 retrieval_regression.py run --tag post-086 --compare pre-ranker-tune")
    return 0


def cmd_show(args):
    print(json.dumps(read_weights(), indent=2))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sweep")
    s.add_argument("--stage", default="relevance",
                   choices=["relevance", "shape", "trgm"])
    s.add_argument("--relevance", type=float, default=0.60,
                   help="relevance weight to hold fixed in the shape/trgm stages")
    s.add_argument("--shape", help="path to a config json to use as the trgm-stage base")
    s.add_argument("--grid", help="path to an explicit [{name, w_*...}] grid")
    s.add_argument("--k", type=int, default=10)
    s.add_argument("--refresh-embeddings", action="store_true")
    s.set_defaults(fn=cmd_sweep)

    a = sub.add_parser("apply")
    a.add_argument("--name", required=True)
    a.add_argument("--stage", required=True)
    a.set_defaults(fn=cmd_apply)

    sub.add_parser("show").set_defaults(fn=cmd_show)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
