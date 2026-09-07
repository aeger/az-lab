#!/usr/bin/env python3
"""
EvolveMem recall diagnosis loop — weekly, READ-ONLY.

WHY THIS EXISTS (2026-09-07, EvolveMem arXiv:2605.13941)
  EvolveMem's argument is that a memory system should treat its own retrieval
  failures as a training signal: cluster the misses, diagnose WHY each cluster
  misses, and let the diagnosis propose a ranker adjustment. We already have both
  halves of that loop in isolation and nothing joining them:

    nightly_eval.sh          produces the failure record (eval_runs / eval_run_results)
    diagnose_probes.py       explains ONE run, on demand, by re-querying live recall
    tune_ranker.py           searches weight space, once someone has a hypothesis

  What was missing is the step that turns a WEEK of recorded misses into a ranked
  set of hypotheses worth sweeping. That is this script. It does not sweep and it
  does not apply — see NO AUTO-APPLY below.

READ-ONLY, AND THAT IS A DESIGN PROPERTY NOT A LIMITATION
  diagnose_probes.py has to take the eval_access_snapshot lock, because it calls
  hybrid_recall and hybrid_recall increments access_count / recall_count /
  last_accessed_at on every row it returns (migration 071) — three columns that
  feed the A-MAC lane it is measuring. This script never calls hybrid_recall. It
  reads eval_run_results, which the nightly already recorded under that lock.
  So it needs no lock, cannot perturb the corpus, and can run concurrently with
  anything. Do not "improve" it by adding a live retrieval call.

THE ABSTENTION TRAP — READ BEFORE CHANGING THE FILTER
  The 8 active `abstention` probes have gold_memory_ids = {} by construction: the
  correct behaviour is to return NOTHING, so gold_rank is ALWAYS NULL and a naive
  "gold_rank IS NULL = miss" query scores them at a 100% miss rate, worst cluster
  in the set, every single week. A diagnosis loop that believed that would keep
  recommending a LOOSER ranker to fix probes whose failure mode is retrieving too
  much. They are excluded from the failure population. `forgetting` probes are
  kept but tagged: they have real gold AND forbidden ids, and their headline
  metric is FCFR (an absence), which no per-probe gold_rank can express.

NO AUTO-APPLY — ON PURPOSE
  Output is a report plus a review task. This script has no code path that writes
  recall_weights, by construction and not by a flag. Two reasons:
    1. system_rules.scoring_function_migration_required — a weight change is a
       migration-provenance event, not a background job's business.
    2. A recommendation derived from observational data is a HYPOTHESIS. The lab
       already owns the instrument that tests one (tune_ranker.py sweep, which
       replays cached probe embeddings across candidate vectors and restores the
       access snapshot between configs). Shipping a weight because an LLM found
       the rationale plausible would skip the only step that produces evidence.
  Every recommendation is therefore emitted as the tune_ranker command that would
  test it, for Wren/Jeff to run deliberately.

USAGE
  python3 evolvemem_diagnose.py                        # 7-day window, report to stdout
  python3 evolvemem_diagnose.py --days 14 --json out.json
  python3 evolvemem_diagnose.py --surface              # + review task + notification
  python3 evolvemem_diagnose.py --no-llm               # deterministic evidence only
"""
import argparse
import collections
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import retrieval_regression as rr  # noqa: E402  (env load, sb_get/sb_post, discord)

RESULTS = Path(__file__).resolve().parent / "results" / "evolvemem"

# Probes whose "miss" is not a retrieval failure. See THE ABSTENTION TRAP above.
EXCLUDED_CATEGORIES = {rr.ABSTENTION_CATEGORY}

# Miss rate over the window at or above which a probe counts as CHRONIC — a
# standing defect rather than a flap. 0.8 = missed in at least 4 of 5 runs.
CHRONIC_AT = float(os.environ.get("EVOLVEMEM_CHRONIC_AT", "0.8"))
# Below this, a probe that misses at all is FLAPPING: it lands near the k=5
# boundary and moves with tie-breaks. Distinct failure, distinct fix.
FLAP_BELOW = float(os.environ.get("EVOLVEMEM_FLAP_BELOW", "0.8"))
# Minimum probes in a (category, tier, failure_mode) cell before it is reported
# as a PATTERN. A single probe is an anecdote and has repeatedly produced
# confident nonsense when handed to an LLM as if it were a trend.
MIN_PATTERN_N = int(os.environ.get("EVOLVEMEM_MIN_PATTERN_N", "3"))

LANES = {
    "w_lane_topic":  "topic_hint lane — MIRIX active-retrieval hint match",
    "w_lane_vec":    "dense embedding lane (nomic-embed-text)",
    "w_lane_bm25w":  "BM25 over whole-document text",
    "w_lane_bm25p":  "BM25 over passage/chunk text",
    "w_lane_entity": "entity dictionary lane",
    "w_lane_trgm":   "trigram fuzzy lane (gated by trgm_floor)",
}
COMPOSITE = ["w_relevance", "w_recency", "w_access", "w_novelty",
             "w_importance", "w_recall_count"]


# ---------------------------------------------------------------- data pull

def fetch_runs(days: int) -> list:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    runs = rr.sb_get("eval_runs", {
        "select": "id,tag,git_sha,created_at,n_queries,recall_at_5,ndcg_at_10,"
                  "false_carry_forward_rate,scoreset_version",
        "created_at": f"gte.{since}",
        "order": "created_at.asc",
    })
    return runs


def fetch_results(run_ids: list) -> list:
    """eval_run_results in chunks — the id filter is a URL, not a bind list."""
    out = []
    for i in range(0, len(run_ids), 20):
        chunk = run_ids[i:i + 20]
        out += rr.sb_get("eval_run_results", {
            "select": "run_id,query_id,gold_rank,hit_at_5,returned_ids,ndcg_at_10,top_score",
            "run_id": f"in.({','.join(chunk)})",
        })
    return out


def fetch_queries() -> dict:
    rows = rr.sb_get("eval_queries", {
        "select": "id,question,topic_hint,category,tier,failure_mode,active,"
                  "gold_memory_ids,forbidden_memory_ids",
    })
    return {r["id"]: r for r in rows}


def fetch_weights() -> dict:
    rows = rr.sb_get("recall_weights", {"select": "*"})
    return rows[0] if rows else {}


def memory_names(ids: list) -> dict:
    """Names for distractor reporting. Reads public.memories directly — a SELECT
    on the table does not touch access_count; only hybrid_recall does."""
    names, ids = {}, [i for i in dict.fromkeys(ids) if i]
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        for m in rr.sb_get("memories", {"select": "id,name,type",
                                        "id": f"in.({','.join(chunk)})"}):
            names[m["id"]] = f'{m["name"]} [{m.get("type") or "?"}]'
    for i in ids:
        names.setdefault(i, "<GONE/INACTIVE>")
    return names


# ------------------------------------------------------------ per-probe roll

def roll_up(results: list, queries: dict, runs: list) -> list:
    order = {r["id"]: n for n, r in enumerate(runs)}
    by_q = collections.defaultdict(list)
    for row in results:
        q = queries.get(row["query_id"])
        if not q or not q.get("active") or q["category"] in EXCLUDED_CATEGORIES:
            continue
        by_q[row["query_id"]].append(row)

    probes = []
    for qid, rows in by_q.items():
        q = queries[qid]
        rows.sort(key=lambda r: order.get(r["run_id"], 0))
        n = len(rows)
        missed = [r for r in rows if not r.get("hit_at_5")]
        ndcgs = [r["ndcg_at_10"] for r in rows if r["ndcg_at_10"] is not None]
        ranks = [r["gold_rank"] for r in rows if r["gold_rank"] is not None]
        miss_rate = len(missed) / n if n else 0.0

        # Regression detection: split the window in half and compare hit rates.
        # A probe that was hitting and now is not is worth more than a probe that
        # has never hit — the first implicates a change, the second a gap.
        half = max(1, n // 2)
        early = sum(1 for r in rows[:half] if r.get("hit_at_5")) / half
        late_rows = rows[half:] or rows[-1:]
        late = sum(1 for r in late_rows if r.get("hit_at_5")) / len(late_rows)

        if miss_rate == 0:
            state = "healthy"
        elif miss_rate >= CHRONIC_AT:
            state = "chronic"
        elif late < early - 0.34:
            state = "regressed"
        elif miss_rate < FLAP_BELOW:
            state = "flapping"
        else:
            state = "chronic"

        probes.append({
            "query_id": qid,
            "question": q["question"],
            "topic_hint": q.get("topic_hint"),
            "category": q["category"],
            "tier": q.get("tier"),
            "failure_mode": q.get("failure_mode"),
            "is_forgetting": q["category"] == rr.FORGETTING_CATEGORY,
            "n_runs": n,
            "miss_rate": round(miss_rate, 3),
            "state": state,
            "mean_ndcg10": round(statistics.fmean(ndcgs), 4) if ndcgs else None,
            "mean_gold_rank": round(statistics.fmean(ranks), 2) if ranks else None,
            "best_gold_rank": min(ranks) if ranks else None,
            "mean_top_score": round(statistics.fmean(
                [r["top_score"] for r in rows if r["top_score"] is not None] or [0]), 4),
            "early_hit": round(early, 2),
            "late_hit": round(late, 2),
            "top5_ids": [r["returned_ids"][:5] for r in rows if r.get("returned_ids")],
            "gold_ids": q.get("gold_memory_ids") or [],
        })
    probes.sort(key=lambda p: (-p["miss_rate"], p["mean_ndcg10"] or 0))
    return probes


def patterns(probes: list) -> list:
    cells = collections.defaultdict(list)
    for p in probes:
        cells[(p["category"], p["tier"], p["failure_mode"])].append(p)
    out = []
    for (cat, tier, fm), ps in cells.items():
        failing = [p for p in ps if p["state"] != "healthy"]
        if not failing:
            continue
        ndcgs = [p["mean_ndcg10"] for p in ps if p["mean_ndcg10"] is not None]
        out.append({
            "category": cat, "tier": tier, "failure_mode": fm,
            "n_probes": len(ps),
            "n_failing": len(failing),
            "n_chronic": sum(1 for p in ps if p["state"] == "chronic"),
            "n_regressed": sum(1 for p in ps if p["state"] == "regressed"),
            "n_flapping": sum(1 for p in ps if p["state"] == "flapping"),
            "mean_miss_rate": round(statistics.fmean([p["miss_rate"] for p in ps]), 3),
            "mean_ndcg10": round(statistics.fmean(ndcgs), 4) if ndcgs else None,
            "is_pattern": len(ps) >= MIN_PATTERN_N,
            "example_questions": [p["question"] for p in failing[:3]],
        })
    out.sort(key=lambda c: (-c["n_chronic"], -c["mean_miss_rate"], -c["n_probes"]))
    return out


def occupancy(probes: list, limit: int = 12) -> list:
    """Which memories eat the top-5 slots on FAILING probes.

    This is the measurement that found the real defect in July 2026 — popularity
    concentration in the A-MAC lane, where `task-queue-system` took a top-5 slot
    on 44.6% of probes regardless of topic. A cluster whose slots are held by one
    or two ubiquitous rows is a prior problem (w_access / w_recall_count); a
    cluster whose slots are held by topically-adjacent rows is a lane-weight
    problem. The two have opposite fixes, so the diagnosis needs this to choose."""
    failing = [p for p in probes if p["state"] != "healthy"]
    slots = collections.Counter()
    total = 0
    for p in failing:
        gold = set(p["gold_ids"])
        for top5 in p["top5_ids"]:
            for mid in top5:
                total += 1
                if mid not in gold:
                    slots[mid] += 1
    names = memory_names([m for m, _ in slots.most_common(limit)])
    return [{"memory_id": m, "name": names.get(m, m), "slots": c,
             "pct_of_failing_slots": round(100.0 * c / total, 1) if total else 0.0}
            for m, c in slots.most_common(limit)]


# ------------------------------------------------------------------ diagnosis

sys.path.insert(0, os.path.expanduser("~/claude/lib"))
try:
    from claude_call import call_claude as _shared_claude_call
except Exception:
    _shared_claude_call = None

DIAG_MODEL = os.environ.get("EVOLVEMEM_MODEL", "claude-sonnet-5")


def diagnosis_prompt(pats, occ, weights, probes, window) -> str:
    lanes = "\n".join(f"  {k} = {weights.get(k)}   # {d}" for k, d in LANES.items())
    comp = "\n".join(f"  {k} = {weights.get(k)}" for k in COMPOSITE)
    pat_lines = "\n".join(
        f"  [{'PATTERN' if p['is_pattern'] else 'thin n=%d' % p['n_probes']}] "
        f"{p['category']}/{p['tier']}/{p['failure_mode'] or 'none'}: "
        f"{p['n_failing']}/{p['n_probes']} failing "
        f"(chronic {p['n_chronic']}, regressed {p['n_regressed']}, flapping {p['n_flapping']}), "
        f"miss_rate {p['mean_miss_rate']}, nDCG@10 {p['mean_ndcg10']}\n"
        + "".join(f"      e.g. {q}\n" for q in p["example_questions"])
        for p in pats)
    occ_lines = "\n".join(
        f"  {o['name']}: {o['slots']} slots ({o['pct_of_failing_slots']}% of top-5 slots on failing probes)"
        for o in occ)
    return f"""You are diagnosing a hybrid retrieval ranker from its own recorded failures.
This is the diagnosis step of an EvolveMem-style loop (arXiv:2605.13941): the output
is a set of HYPOTHESES to be tested with a sweep, not changes to apply.

RANKER SHAPE
  6-lane Reciprocal Rank Fusion, k=60, then an INT8 cross-encoder rerank of top-20.
  Lane weights multiply each lane's RRF contribution:
{lanes}
  Fused candidates are then scored by a 6-term A-MAC composite:
{comp}
  trgm_floor = {weights.get('trgm_floor')} (similarity gate on the trigram lane)
  idf_adaptive_enabled = {weights.get('idf_adaptive_enabled')}

EVIDENCE — {window}
Failure clusters (abstention probes excluded: their correct answer is to return nothing,
so they are not retrieval failures):
{pat_lines or '  (none)'}

Top-5 slot occupancy on failing probes — non-gold memories crowding the cut:
{occ_lines or '  (none)'}

HOW TO READ THE OCCUPANCY TABLE
  If a few ubiquitous memories hold slots ACROSS UNRELATED clusters, that is
  popularity concentration in the composite prior (w_access, w_recall_count,
  w_importance), not a lane problem — lowering a lane weight will not fix it.
  If the crowding rows are topically adjacent to each probe, that IS a lane
  balance problem.

TASK
  Return JSON only, no prose outside it:
  {{"findings": [
     {{"cluster": "<category/tier/failure_mode>",
       "diagnosis": "<what is going wrong mechanically, 1-3 sentences>",
       "evidence": "<the specific numbers above that support it>",
       "recommendation": <null if no weight change is warranted, else
                          {{"knob": "<exact column name in recall_weights>",
                            "direction": "increase|decrease",
                            "suggested_value": <number>,
                            "current_value": <number>}}>,
       "confidence": "high|medium|low",
       "risk": "<which currently-healthy cluster this could regress>"}}
   ],
   "no_change_clusters": ["<clusters where the evidence does not implicate the ranker, with why>"],
   "overall": "<2-3 sentences: is the ranker the bottleneck this week, or the probe set / corpus?>"}}

CONSTRAINTS
  - At most 4 findings. Rank by evidence strength, not by cluster size.
  - Only recommend knobs from the lists above; invent nothing.
  - A cluster of fewer than {MIN_PATTERN_N} probes is marked 'thin' — do not build a
    finding on one unless the effect is unambiguous, and say so in confidence.
  - Clusters whose misses are 'flapping' rather than 'chronic' sit at the k=5
    boundary; say so rather than proposing a large weight move.
  - If a cluster warrants NO weight change, set "recommendation": null. Do NOT invent a
    placeholder knob. The first run of this loop emitted {{"knob":"none","suggested_value":0}}
    for two such findings, which rendered as a runnable-looking sweep command for a knob
    that does not exist — a reviewer could have pasted it. null is the correct answer.
  - If the honest answer is that the misses are gold-label or corpus-coverage
    problems rather than ranker problems, say that in no_change_clusters. That is a
    valid and useful result.
"""


def run_diagnosis(prompt: str) -> dict:
    """Diagnose via claude_call's default tier chain (0=Max subscription, 2=NemoClaw).
    Both are non-billable; the metered Tier 1 key is deliberately NOT in the chain,
    because an unattended weekly job should never be able to generate a charge.

    thinking=False IS LORE-BEARING. Left at the model default, Sonnet 5 spent the
    ENTIRE max_tokens budget on thinking tokens and returned a zero-length text
    block — the first run of this script reported "diagnosis returned empty" while
    the call itself succeeded and billed 2000 output tokens. An extended-thinking
    budget is not free headroom; it comes out of the same max_tokens the answer
    needs. If you re-enable thinking here, raise max_tokens well above the ~2.7k
    the JSON answer alone costs."""
    if _shared_claude_call is None:
        return {"error": "claude_call helper unavailable (~/claude/lib) — evidence only"}
    try:
        res = _shared_claude_call([{"role": "user", "content": prompt}],
                                  model=DIAG_MODEL, max_tokens=4000, thinking=False)
        text = (res.get("content") or "").strip()
    except Exception as e:
        return {"error": f"diagnosis call failed: {e}"}
    if not text:
        return {"error": "diagnosis returned empty"}
    body = text[text.find("{"):text.rfind("}") + 1] if "{" in text else ""
    try:
        return json.loads(body)
    except Exception as e:
        return {"error": f"unparseable diagnosis: {e}", "raw": text[:1500]}


# --------------------------------------------------------------------- report

KNOBS = set(LANES) | set(COMPOSITE) | {"trgm_floor", "idf_strength", "idf_pivot"}


def valid_rec(rec) -> bool:
    """A recommendation is only renderable if it names a REAL recall_weights column.
    Belt and braces against the model answering "no change" with a placeholder knob
    instead of null — see the note in the prompt. An unrenderable recommendation is
    dropped rather than shown, because the failure mode we are guarding against is a
    reviewer copy-pasting a sweep command for a knob that does not exist."""
    return bool(rec) and isinstance(rec, dict) and rec.get("knob") in KNOBS


def sweep_cmd(rec: dict) -> str:
    knob = rec.get("knob", "")
    stage = {"w_relevance": "relevance", "w_lane_trgm": "trgm"}.get(knob)
    if stage:
        return f"python3 tune_ranker.py sweep --stage {stage}"
    return (f"python3 tune_ranker.py sweep --grid <(echo '"
            f'[{{"name":"{knob}-{rec.get("suggested_value")}",'
            f'"{knob}":{rec.get("suggested_value")}}}]\')')


def render(report: dict) -> str:
    w, L = report["window"], []
    L.append(f"# EvolveMem recall diagnosis — {report['generated_at'][:10]}")
    L.append("")
    L.append(f"Window: {w['days']}d, {w['n_runs']} runs ({w['first']} -> {w['last']}), "
             f"{report['n_probes']} probes after excluding {w['n_excluded']} abstention probes.")
    L.append(f"Source: eval_run_results (READ-ONLY — no hybrid_recall call, corpus untouched).")
    L.append("")
    L.append(f"**{report['counts']['chronic']} chronic**, {report['counts']['regressed']} regressed, "
             f"{report['counts']['flapping']} flapping, {report['counts']['healthy']} healthy.")
    L.append("")
    L.append("## Failure clusters")
    L.append("")
    L.append("| cluster | failing/n | chronic | regressed | flapping | miss rate | nDCG@10 |")
    L.append("|---|---|---|---|---|---|---|")
    for p in report["patterns"]:
        tag = "" if p["is_pattern"] else " _(thin)_"
        L.append(f"| {p['category']}/{p['tier']}/{p['failure_mode'] or '—'}{tag} "
                 f"| {p['n_failing']}/{p['n_probes']} | {p['n_chronic']} | {p['n_regressed']} "
                 f"| {p['n_flapping']} | {p['mean_miss_rate']} | {p['mean_ndcg10']} |")
    L.append("")
    L.append("## Top-5 slot occupancy on failing probes")
    L.append("")
    for o in report["occupancy"]:
        L.append(f"- `{o['name']}` — {o['slots']} slots ({o['pct_of_failing_slots']}%)")
    L.append("")
    d = report.get("diagnosis") or {}
    L.append("## Diagnosis")
    L.append("")
    if d.get("error"):
        L.append(f"_LLM diagnosis unavailable: {d['error']}. Evidence above stands on its own._")
    else:
        if d.get("overall"):
            L.append(d["overall"])
            L.append("")
        for i, f in enumerate(d.get("findings", []), 1):
            rec = f.get("recommendation") or {}
            rec = rec if valid_rec(rec) else {}
            L.append(f"### {i}. {f.get('cluster')} — confidence {f.get('confidence')}")
            L.append("")
            L.append(f"{f.get('diagnosis')}")
            L.append("")
            L.append(f"- Evidence: {f.get('evidence')}")
            if rec:
                L.append(f"- **Proposed**: `{rec.get('knob')}` "
                         f"{rec.get('current_value')} -> {rec.get('suggested_value')} "
                         f"({rec.get('direction')})")
                L.append(f"- Test it: `{sweep_cmd(rec)}`")
            else:
                L.append("- **Proposed**: no weight change")
            L.append(f"- Risk: {f.get('risk')}")
            L.append("")
        if d.get("no_change_clusters"):
            L.append("**Not a ranker problem:**")
            for n in d["no_change_clusters"]:
                L.append(f"- {n}")
            L.append("")
    L.append("---")
    L.append("")
    L.append("NOTHING ABOVE HAS BEEN APPLIED. These are hypotheses derived from observational")
    L.append("data. Validate with `tune_ranker.py sweep`, certify the winner with")
    L.append("`retrieval_regression.py run --compare`, and ship it as a numbered migration")
    L.append("(system_rules.scoring_function_migration_required) — not by UPDATE on recall_weights.")
    return "\n".join(L)


# --------------------------------------------------------------------- surface

def surface(report: dict, md_path: Path) -> None:
    d = report.get("diagnosis") or {}
    n_find = sum(1 for f in (d.get("findings") or [])
                 if valid_rec(f.get("recommendation")))
    c = report["counts"]
    # WHY target='jeff' / pending_jeff_action AND A DECISION-SHAPED TITLE
    #   The deliverable of this review is a decision that is not an agent's to make:
    #   whether to move a ranker weight, which system_rules.scoring_function_migration_required
    #   makes a migration-provenance event. Filed at an agent target with a runnable
    #   status and a bare-verb title ("Review recall diagnosis"), the queue runner would
    #   claim it and "review" it by agreeing with itself — the exact shape of the
    #   2026-07-28 ntfy gate bypass, where a task saying "nothing will be deployed until
    #   this is answered" was claimed and executed 31 seconds later.
    #
    #   status: NOT 'review_needed'. That value is retired (migrations 118/121) and
    #   trg_aa_task_queue_coerce_retired_status silently rewrites it to
    #   pending_jeff_action, stamping context.coerced_from and raising a WARNING the
    #   PostgREST client never shows. The first run of this script filed review_needed
    #   and the row came back coerced. Write the real status.
    title = (f"DECISION NEEDED (Jeff): EvolveMem recall diagnosis {report['generated_at'][:10]} — "
             f"sweep {n_find} lane-weight hypotheses, or leave the ranker alone?")
    action = (f"{n_find} lane-weight hypotheses from {c['chronic']} chronic recall misses. "
              f"Decide which (if any) are worth a tune_ranker sweep. Nothing has been "
              f"applied and nothing will be without your answer.")
    try:
        rr.sb_post("task_queue", {
            "title": title,
            "description": (f"Weekly EvolveMem read-only recall diagnosis.\n\n"
                            f"Report: {md_path}\n\n"
                            + render(report)[:6000]),
            "source": "claude-code", "target": "jeff",
            "status": "pending_jeff_action", "priority": 2,
            "tags": ["memory", "recall", "evolvemem", "analysis"],
            "context": {"action_required": action, "report_path": str(md_path),
                        "auto_apply": False, "n_hypotheses": n_find,
                        "chronic_probes": c["chronic"]},
        })
        print(f"  surfaced: task_queue pending_jeff_action (target=jeff)")
    except Exception as e:
        print(f"  ! task_queue insert failed: {e}", file=sys.stderr)
    try:
        rr.sb_post("sentinel_notifications", {
            "source": "services", "severity": "info", "title": title,
            "body": f"{c['chronic']} chronic / {c['regressed']} regressed probes over "
                    f"{report['window']['n_runs']} runs. {n_find} lane-weight hypotheses "
                    f"for review — none applied. Report: {md_path}",
            "status": "unread",
        })
    except Exception as e:
        print(f"  ! sentinel notification failed: {e}", file=sys.stderr)
    rr.discord(f"🧪 **EvolveMem diagnosis** — {c['chronic']} chronic / {c['regressed']} regressed "
               f"probes this week, {n_find} lane-weight hypotheses surfaced for review. "
               f"Read-only, nothing applied. `{md_path}`")


# ------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", help="write the full machine-readable report here")
    ap.add_argument("--no-llm", action="store_true", help="evidence only, skip diagnosis")
    ap.add_argument("--surface", action="store_true",
                    help="file a review task + notification + Discord")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not rr.SUPABASE_URL or not rr.SUPABASE_KEY:
        rr.die("SUPABASE_URL / SUPABASE_SECRET_KEY not set")

    runs = fetch_runs(args.days)
    if not runs:
        print(f"no eval_runs in the last {args.days}d — nothing to diagnose "
              f"(is memory-eval-nightly.timer running?)", file=sys.stderr)
        return 0
    results = fetch_results([r["id"] for r in runs])
    queries = fetch_queries()
    weights = fetch_weights()

    n_excluded = sum(1 for q in queries.values()
                     if q.get("active") and q["category"] in EXCLUDED_CATEGORIES)
    probes = roll_up(results, queries, runs)
    pats = patterns(probes)
    occ = occupancy(probes)
    counts = collections.Counter(p["state"] for p in probes)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window": {"days": args.days, "n_runs": len(runs),
                   "first": runs[0]["created_at"][:10], "last": runs[-1]["created_at"][:10],
                   "tags": [r["tag"] for r in runs], "n_excluded": n_excluded},
        "n_probes": len(probes),
        "counts": {k: counts.get(k, 0) for k in
                   ("chronic", "regressed", "flapping", "healthy")},
        "weights": weights,
        "patterns": pats,
        "occupancy": occ,
        "probes": probes if args.json else
                  [p for p in probes if p["state"] != "healthy"],
        "auto_applied": False,
    }

    if not args.no_llm:
        window = (f"{args.days} days, {len(runs)} nightly runs, "
                  f"{runs[0]['created_at'][:10]} to {runs[-1]['created_at'][:10]}")
        report["diagnosis"] = run_diagnosis(
            diagnosis_prompt(pats, occ, weights, probes, window))
        report["diagnosis_model"] = DIAG_MODEL

    md = render(report)
    RESULTS.mkdir(parents=True, exist_ok=True)
    stamp = report["generated_at"][:10].replace("-", "")
    md_path = RESULTS / f"diagnosis_{stamp}.md"
    md_path.write_text(md)
    # Strip the per-probe dump out of the JSON copy only if it was not requested.
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str))
    (RESULTS / f"diagnosis_{stamp}.json").write_text(json.dumps(report, indent=2, default=str))

    if not args.quiet:
        print(md)
    print(f"\n  report: {md_path}", file=sys.stderr)

    if args.surface:
        surface(report, md_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
