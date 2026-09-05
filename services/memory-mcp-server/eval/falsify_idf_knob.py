#!/usr/bin/env python3
"""
Falsification test for the IDF-adaptive lane-weight knob (2026-08-01 research REC 3).

THE QUESTION
  The 2026-07-31 A/B recorded `idf-on-treatment` (strength 0.5) and `idf-str1.2`
  (strength 1.2) with BIT-IDENTICAL metrics -- MRR 0.688185654008439 and
  nDCG 0.702632792830539 to 15 decimal places across 79 probes. A 2.4x change in a
  weighting coefficient that produces identical floats on every probe is not a
  measurement, it is a signal that the coefficient never reached the arithmetic.
  Research REC 3: prove or delete the knob, and do not stack ranker work on it
  until that is settled.

WHAT THE LIVE FUNCTION ACTUALLY DOES (recovered in migration 093)
    IF COALESCE(v_idf_on, false) THEN
      v_idf  := public.query_idf_norm(COALESCE(v_topic, p_query_text));
      v_tilt := COALESCE(v_idf_str, 0.5) * (v_idf - COALESCE(v_idf_pivot, 0.413));
      v_tilt := GREATEST(-0.9, LEAST(0.9, v_tilt));
      v_wl_bm25w := v_wl_bm25w * (1.0 + v_tilt);   ... etc
      v_wl_vec   := v_wl_vec   * (1.0 - v_tilt);
    END IF;
  The whole block is gated on `recall_weights.idf_adaptive_enabled`, which is
  FALSE in the live row. So `idf_strength` is only reachable when the flag is on.

THREE PHASES, EACH FALSIFIABLE ON ITS OWN

  PHASE 1 -- ARITHMETIC (no retrieval, no mutation).
    Compute the effective per-lane weights the live formula produces for every
    active probe at strength 0.5 and at 1.2, using the REAL query_idf_norm() over
    the REAL corpus. If the two weight vectors are identical, the knob genuinely
    cannot reach the arithmetic and it is dead code -- delete it. If they differ,
    the knob IS wired and the 07-31 A/B measured something else.

  PHASE 2 -- RANKING SENSITIVITY (retrieval, non-mutating).
    Run every active probe through the real hybrid_recall path three times:
    flag off (control), on@0.5, on@1.2. Compare the RETURNED ID LISTS, not just
    the aggregate metrics. Aggregates can collide while lists differ; identical
    lists are the only thing that justifies "no effect". This is the step the
    07-31 A/B skipped -- it compared four summary floats and concluded from a
    collision.

  PHASE 3 -- VERDICT.
    wired + list-sensitive        -> knob is real; the 07-31 result is still
                                    unattributable and must be retracted, but the
                                    knob may be tuned.
    wired + list-insensitive      -> knob is real but inert on THIS scoreset;
                                    a 79-probe set cannot tune it. Leave OFF.
    not wired                     -> dead knob; remove it from hybrid_recall.

SAFETY
  Mutates exactly one row (public.recall_weights) and restores it in a finally
  block from a snapshot taken before anything is changed. Takes the same eval lock
  as the nightly (eval_access_snapshot is a single shared table -- see
  nightly_eval.sh) and does NOT write to eval_runs: this is a diagnostic, not a
  recorded run, and a diagnostic in the trend series would poison the gate median.

USAGE
  python3 falsify_idf_knob.py                 # all three phases
  python3 falsify_idf_knob.py --arithmetic-only   # phase 1, zero retrieval calls
  python3 falsify_idf_knob.py --limit 20      # phase 2 on a subset (faster)
"""
import argparse
import json
import sys

import httpx

import retrieval_regression as rr  # env loading, embed(), sb_*(), retrieve(), eval_lock()

# The lane weights the live hybrid_recall tilts, and the direction of the tilt.
# entity is deliberately NOT tilted -- extract_entities() already emits only
# high-IDF surface forms, so scaling it by query IDF double-counts. Mirroring that
# exclusion here is the point: phase 1 has to model the function as it IS.
TILTED_UP = ("bm25w", "bm25p", "topic", "trgm")
TILTED_DOWN = ("vec",)
UNTILTED = ("entity",)

WEIGHT_COLS = {
    "vec": "w_lane_vec", "bm25w": "w_lane_bm25w", "bm25p": "w_lane_bm25p",
    "topic": "w_lane_topic", "entity": "w_lane_entity", "trgm": "w_lane_trgm",
}


def read_weights() -> dict:
    rows = rr.sb_get("recall_weights", {"select": "*", "limit": "1"})
    if not rows:
        rr.die("recall_weights has no row — hybrid_recall would be running on "
               "its COALESCE defaults; fix that before tuning anything")
    return rows[0]


def write_weights(patch: dict) -> None:
    r = httpx.patch(
        f"{rr.SUPABASE_URL}/rest/v1/recall_weights",
        headers={**rr.SB_HEADERS, "Prefer": "return=minimal"},
        params={"id": "eq.true"}, json=patch, timeout=30,
    )
    r.raise_for_status()


def effective_weights(base: dict, idf: float, strength: float, pivot: float) -> dict:
    """Pure-python mirror of the live tilt arithmetic, including the clamp."""
    tilt = strength * (idf - pivot)
    tilt = max(-0.9, min(0.9, tilt))
    out = {}
    for lane, col in WEIGHT_COLS.items():
        w = base[col]
        if lane in TILTED_UP:
            out[lane] = w * (1.0 + tilt)
        elif lane in TILTED_DOWN:
            out[lane] = w * (1.0 - tilt)
        else:
            out[lane] = w
    out["_tilt"] = tilt
    out["_idf"] = idf
    return out


def probe_idf(text: str) -> float:
    """The REAL query_idf_norm over the REAL corpus — not a reimplementation.
    A python copy of the IDF formula would be testing the copy."""
    res = rr.sb_rpc("query_idf_norm", {"p_text": text})
    # PostgREST returns a scalar for a scalar-returning function.
    return float(res if not isinstance(res, list) else res[0])


def phase1_arithmetic(probes: list, base: dict, s_lo: float, s_hi: float, pivot: float):
    print(f"\n=== PHASE 1 — ARITHMETIC ({len(probes)} probes, no retrieval) ===")
    print(f"    pivot={pivot}  strength_lo={s_lo}  strength_hi={s_hi}")
    differing = 0
    clamped = 0
    max_gap = 0.0
    rows = []
    for p in probes:
        text = p.get("topic_hint") or p["question"]
        idf = probe_idf(text)
        lo = effective_weights(base, idf, s_lo, pivot)
        hi = effective_weights(base, idf, s_hi, pivot)
        gap = max(abs(lo[l] - hi[l]) for l in WEIGHT_COLS)
        if gap > 1e-12:
            differing += 1
        if abs(lo["_tilt"]) >= 0.9 - 1e-9 and abs(hi["_tilt"]) >= 0.9 - 1e-9:
            clamped += 1
        max_gap = max(max_gap, gap)
        rows.append((p, idf, lo, hi, gap))

    rows.sort(key=lambda r: -r[4])
    print(f"\n  probes whose effective lane weights DIFFER between "
          f"strength {s_lo} and {s_hi}: {differing}/{len(probes)}")
    print(f"  probes where BOTH strengths saturate the +-0.9 clamp "
          f"(would explain a collision): {clamped}/{len(probes)}")
    print(f"  largest single-lane weight gap: {max_gap:.6f}\n")
    print(f"  {'idf':>6} {'tilt@lo':>8} {'tilt@hi':>8} {'vec_lo':>7} {'vec_hi':>7} "
          f"{'bm25w_lo':>9} {'bm25w_hi':>9}  probe")
    for p, idf, lo, hi, gap in rows[:5] + rows[-3:]:
        print(f"  {idf:6.3f} {lo['_tilt']:8.4f} {hi['_tilt']:8.4f} "
              f"{lo['vec']:7.4f} {hi['vec']:7.4f} {lo['bm25w']:9.4f} {hi['bm25w']:9.4f}"
              f"  {(p.get('topic_hint') or p['question'])[:44]}")
    return {"n": len(probes), "differing": differing, "clamped_both": clamped,
            "max_gap": max_gap, "wired": differing > 0}


def collect_lists(probes: list, k: int, label: str) -> dict:
    out = {}
    for i, p in enumerate(probes, 1):
        try:
            out[p["id"]] = rr.retrieve(p["question"], p.get("topic_hint"), k)
        except Exception as e:
            print(f"  ! {label}: retrieval failed for {p['id']}: {e}", file=sys.stderr)
            out[p["id"]] = []
        if i % 20 == 0:
            print(f"    {label}: {i}/{len(probes)}")
    return out


def compare(a: dict, b: dict, probes: list, label: str) -> dict:
    changed = [p for p in probes if a.get(p["id"]) != b.get(p["id"])]
    top1 = [p for p in probes
            if (a.get(p["id"]) or [None])[0] != (b.get(p["id"]) or [None])[0]]
    print(f"  {label}: {len(changed)}/{len(probes)} probes returned a DIFFERENT id list; "
          f"{len(top1)} changed at rank 1")
    return {"changed": len(changed), "changed_top1": len(top1),
            "examples": [(p["question"][:60]) for p in changed[:5]]}


def phase2_ranking(probes: list, base: dict, s_lo: float, s_hi: float, pivot: float, k: int):
    print(f"\n=== PHASE 2 — RANKING SENSITIVITY ({len(probes)} probes x 3 arms, k={k}) ===")
    snapshot = {c: base[c] for c in ("idf_adaptive_enabled", "idf_strength", "idf_pivot")}
    print(f"    restoring afterwards to: {snapshot}")
    try:
        write_weights({"idf_adaptive_enabled": False})
        off = collect_lists(probes, k, "off/control")

        write_weights({"idf_adaptive_enabled": True, "idf_strength": s_lo, "idf_pivot": pivot})
        lo = collect_lists(probes, k, f"on@{s_lo}")

        write_weights({"idf_adaptive_enabled": True, "idf_strength": s_hi, "idf_pivot": pivot})
        hi = collect_lists(probes, k, f"on@{s_hi}")
    finally:
        write_weights(snapshot)
        after = read_weights()
        ok = all(after[c] == snapshot[c] for c in snapshot)
        print(f"    recall_weights restored: {'OK' if ok else 'FAILED — CHECK MANUALLY'}")
        if not ok:
            rr.die(f"recall_weights NOT restored; wanted {snapshot}, found "
                   f"{ {c: after[c] for c in snapshot} }")

    print()
    r1 = compare(off, lo, probes, f"off  vs on@{s_lo}")
    r2 = compare(off, hi, probes, f"off  vs on@{s_hi}")
    r3 = compare(lo, hi, probes, f"on@{s_lo} vs on@{s_hi}")
    return {"off_vs_lo": r1, "off_vs_hi": r2, "lo_vs_hi": r3}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strength-lo", type=float, default=0.5)
    ap.add_argument("--strength-hi", type=float, default=1.2)
    ap.add_argument("--pivot", type=float, default=None,
                    help="default: the live recall_weights.idf_pivot")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0, help="phase 2 probe cap (0 = all)")
    ap.add_argument("--arithmetic-only", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rr.load_env()
    base = read_weights()
    pivot = args.pivot if args.pivot is not None else base["idf_pivot"]

    print("live recall_weights: " + ", ".join(
        f"{k}={base[k]}" for k in ("idf_adaptive_enabled", "idf_strength", "idf_pivot")))

    probes = rr.sb_get("eval_queries", {
        "select": "id,question,topic_hint,category,gold_memory_ids",
        "active": "is.true", "order": "category,created_at"})
    if not probes:
        rr.die("no active eval_queries")

    report = {"strength_lo": args.strength_lo, "strength_hi": args.strength_hi,
              "pivot": pivot, "live_weights": {k: base[k] for k in WEIGHT_COLS.values()}}
    report["phase1"] = phase1_arithmetic(probes, base, args.strength_lo, args.strength_hi, pivot)

    if not args.arithmetic_only:
        sub = probes[: args.limit] if args.limit else probes
        with rr.eval_lock("falsify_idf_knob"):
            report["phase2"] = phase2_ranking(sub, base, args.strength_lo,
                                              args.strength_hi, pivot, args.k)

    print("\n=== PHASE 3 — VERDICT ===")
    wired = report["phase1"]["wired"]
    if not wired:
        verdict = ("NOT WIRED — identical effective weights at both strengths. "
                   "The knob is dead code; remove it from hybrid_recall.")
    else:
        p2 = report.get("phase2")
        if p2 is None:
            verdict = ("WIRED (arithmetic differs). Ranking sensitivity not measured "
                       "— rerun without --arithmetic-only.")
        elif p2["lo_vs_hi"]["changed"] == 0:
            verdict = (f"WIRED BUT INERT on this scoreset: effective lane weights differ "
                       f"on {report['phase1']['differing']}/{report['phase1']['n']} probes, "
                       f"yet 0 probes changed their returned id list between "
                       f"strength {args.strength_lo} and {args.strength_hi}. The 07-31 "
                       f"'identical floats' result is EXPLAINED, not a bug — but it also "
                       f"means a 79-probe set cannot tune this knob. Leave it OFF and do "
                       f"not build on it until the scoreset can resolve it (REC 2).")
        else:
            verdict = (f"WIRED AND SENSITIVE: {p2['lo_vs_hi']['changed']} probes changed "
                       f"their returned id list between strengths. The 07-31 A/B collision "
                       f"was therefore NOT caused by a dead knob — investigate whether both "
                       f"arms actually ran with idf_adaptive_enabled=true.")
    report["verdict"] = verdict
    print("  " + verdict.replace(". ", ".\n  "))

    if args.json:
        print("\n" + json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
