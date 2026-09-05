#!/usr/bin/env python3
"""
Falsification test for eval_runs.false_carry_forward_rate (2026-07-30 research REC 1).

THE QUESTION
  FCFR has read exactly 0.0000 on all 6 runs that ever recorded it, including
  `fama-084-baseline` whose own note says "first run". A metric that has never moved
  off its zero default is more likely un-wired than perfect. Settle it by construction
  rather than by reading the code.

TWO INDEPENDENT FAILURE MODES, TESTED SEPARATELY
  A. UN-WIRED CODE — score() computes carry_forward_hits but the number never
     reaches eval_runs, or the top-10 slice never intersects `forbidden`.
     Tested with a POSITIVE CONTROL: mirror a real positive probe into a forgetting
     probe whose forbidden set IS its own gold. Gold sits at rank 1-5 on the current
     corpus (recall@5 = 1.0000), so a wired metric MUST report FCFR = 1.0 here.
     If it reports 0.0, the metric is un-wired. That is the falsification.

  B. VACUOUS DATA — the code is wired, but every forbidden id is `is_active = false`,
     and all six hybrid_recall lanes filter on is_active (14 references in the live
     function body). Then no forbidden id can EVER be returned, FCFR is pinned at 0
     by construction, and the metric measures the is_active filter rather than the
     ranker. Tested by the reachability audit in phase A — it needs no retrieval.

  A metric can pass A and still be worthless because of B. Both are reported.

USAGE
  python3 falsify_fcfr.py              # audit + positive control (non-mutating)
  python3 falsify_fcfr.py --audit-only # phase A only, zero retrieval calls
"""
import argparse
import json
import sys

import retrieval_regression as rr

NEG_CONTROL_ID = "00000000-0000-0000-0000-000000000000"


def audit_reachability():
    """Phase A — can the declared forbidden memories be returned by hybrid_recall AT ALL?

    hybrid_recall filters `is_active IS NOT FALSE` on every lane, so a forbidden id
    whose row is inactive is unreachable by construction and its probe can never
    contribute to FCFR. Those probes are not measuring forgetting; they are measuring
    that a WHERE clause exists."""
    # EVERY probe that declares forbidden ids, not just category='forgetting'.
    # score() counts forbidden ids for any probe that has them, so a dynamic_state
    # probe (migration 091) contributes to FCFR exactly like a forgetting one.
    # Filtering on the category here would have reported "0/9 scorable" on
    # 2026-07-30 while two reachable dynamic_state probes were live — an audit
    # that under-reports its own coverage is the same class of bug it exists to
    # catch.
    probes = [p for p in rr.sb_get("eval_queries", {
        "select": "id,question,category,forbidden_memory_ids",
        "active": "is.true", "order": "category,created_at",
    }) if p.get("forbidden_memory_ids")]
    if not probes:
        rr.die("no active probe declares forbidden_memory_ids — nothing to audit")

    all_ids = sorted({i for p in probes for i in (p.get("forbidden_memory_ids") or [])})
    rows = rr.sb_get("memories", {
        "select": "id,name,is_active,superseded_by",
        "id": f"in.({','.join(all_ids)})",
    }) if all_ids else []
    state = {r["id"]: r for r in rows}

    print("=" * 78)
    print("PHASE A — forbidden-id reachability audit (no retrieval)")
    print("=" * 78)
    scorable, vacuous, missing_total = 0, 0, 0
    for p in probes:
        fids = p.get("forbidden_memory_ids") or []
        live = [i for i in fids if state.get(i, {}).get("is_active") is not False]
        missing = [i for i in fids if i not in state]
        missing_total += len(missing)
        verdict = "SCORABLE" if live else "VACUOUS "
        scorable += bool(live)
        vacuous += (not live)
        print(f"  [{verdict}] {len(live)}/{len(fids)} reachable  "
              f"[{p['category'][:13]:<13}] {p['question'][:40]}")
        if missing:
            print(f"             ! {len(missing)} forbidden id(s) not in memories at all")

    print(f"\n  {scorable}/{len(probes)} probes CAN contribute to FCFR; "
          f"{vacuous}/{len(probes)} are vacuous (all forbidden ids inactive).")
    if missing_total:
        print(f"  {missing_total} forbidden id(s) reference rows that no longer exist.")
    return probes, scorable, vacuous


def positive_control(k: int):
    """Phase B — mirror real positive probes into forgetting probes whose forbidden
    set is their own gold, then score them through the REAL score() function.

    Gold is retrieved at rank 1-5 for these probes on the current corpus, so a wired
    FCFR is forced to 1.0. Nothing is written to eval_queries or eval_runs; the rows
    exist only in this process. Access stats are snapshotted/restored exactly as
    cmd_run does, so the control is non-mutating like every other harness path."""
    src = rr.sb_get("eval_queries", {
        "select": "id,question,topic_hint,gold_memory_ids,forbidden_memory_ids,category",
        "active": "is.true", "category": "neq.forgetting",
        "gold_memory_ids": "not.is.null", "order": "created_at", "limit": "3",
    })
    if not src:
        rr.die("no positive probes to mirror")

    rows = []
    for q in src:
        rows.append(dict(q))                                    # positive, as-is
        rows.append({**q, "id": q["id"], "category": rr.FORGETTING_CATEGORY,
                     "gold_memory_ids": [],
                     "forbidden_memory_ids": q["gold_memory_ids"]})  # forced violation
    # Negative control: a forbidden id that cannot exist. A wired metric scores this
    # probe clean, which proves phase B is not just returning 1.0 unconditionally.
    rows.append({**src[0], "category": rr.FORGETTING_CATEGORY,
                 "gold_memory_ids": [], "forbidden_memory_ids": [NEG_CONTROL_ID]})

    print("\n" + "=" * 78)
    print("PHASE B — positive control (forbidden := own gold, must force FCFR = 1.0)")
    print("=" * 78)
    with rr.eval_lock("falsify_fcfr"):
        snapped = rr.sb_rpc("eval_access_snapshot_take", {})
        print(f"access-stat snapshot taken ({snapped} rows) — control is non-mutating")
        try:
            _, metrics, failures, fcf = rr.score(rows, k, verbose=True)
        finally:
            repaired = rr.sb_rpc("eval_access_snapshot_restore", {})
            print(f"access stats restored ({repaired} rows perturbed)")

    fcfr = metrics["false_carry_forward_rate"]
    print(f"\n  forgetting probes scored : {fcf['n']}  (3 forced + 1 negative control)")
    print(f"  carry-forward hits       : {fcf['hits']}  (expected 3)")
    print(f"  FCFR                     : {fcfr}")
    if failures:
        print(f"  ! {failures} retrieval(s) errored — control is inconclusive", file=sys.stderr)
        return None, fcf
    return fcfr, fcf


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audit-only", action="store_true")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    probes, scorable, vacuous = audit_reachability()
    if args.audit_only:
        return 0

    fcfr, fcf = positive_control(args.k)

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    if fcfr is None:
        print("  INCONCLUSIVE — retrieval failures during the control run.")
        rc = 2
    elif fcfr == 0.0:
        print("  METRIC IS UN-WIRED. A forbidden id that is provably in the top-10")
        print("  (it is the gold, retrieved at rank 1-5) scored zero carry-forward.")
        print("  Fix the scoring path before trusting any FCFR reading.")
        rc = 1
    else:
        expected = 3 / fcf["n"]
        ok = abs(fcfr - expected) < 1e-9
        print(f"  METRIC IS WIRED — forced violations scored (FCFR {fcfr:.4f}, "
              f"expected {expected:.4f}){'' if ok else ' — MISMATCH, investigate'}")
        print(f"  The negative control stayed clean, so the path is not returning 1.0 blindly.")
        print()
        if vacuous:
            print(f"  BUT THE PRODUCTION READING IS VACUOUS: {vacuous}/{len(probes)} real")
            print(f"  forgetting probes declare only is_active=false forbidden ids. "
                  f"hybrid_recall")
            print("  filters is_active on every lane, so those probes cannot fail by")
            print("  construction. FCFR = 0.0000 on the nightly is measuring the "
                  "is_active")
            print("  filter, not the ranker. Re-seed them against REACHABLE stale rows.")
            rc = 1
        else:
            print("  All real probes are scorable — FCFR 0.0 on the nightly is a real pass.")
            rc = 0
    if args.json:
        print(json.dumps({"fcfr_control": fcfr, "probes": len(probes),
                          "scorable": scorable, "vacuous": vacuous}))
    return rc


if __name__ == "__main__":
    sys.exit(main())
