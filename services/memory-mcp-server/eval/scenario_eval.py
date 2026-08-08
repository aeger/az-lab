#!/usr/bin/env python3
"""scenario_eval.py — troubleshooting-scenario eval across KNOWLEDGE SUBSTRATES.

Where memory_eval.py measures generic QA over injection *strategies*, this measures
a realistic incident: given the SAME problem report, how good is the agent's fix
under three conditions?

  blind   no context — the model's parametric knowledge only
  docs    a "well-documented homelab": structural docs + configs (topology, plugin,
          access path) — but NOT the past-incident fix
  memory  the az-lab memory MCP (real hybrid_recall retrieval) — which carries the
          distilled experiential fix from when this actually happened

This is the concrete version of the project's core question: does an agentic memory
layer beat (a) nothing and (b) a conventional docs/RAG setup, on a real task?

Answers are graded against a GOLD reference (the actual known fix) with a rubric
(root_cause / fix_correct / specificity / topology / safety), not a single 0/1 —
troubleshooting quality is multi-dimensional. Each condition is run R times to
reduce single-shot variance.

Usage:
  python3 scenario_eval.py run --scenario scenarios/homebridge_alexa.json \
      --conditions blind,docs,memory --reps 3 --k 6 --tag hb1
"""
import argparse
import json
import sys
import time
from pathlib import Path

# reuse the validated low-level clients + config from memory_eval
from memory_eval import embed, sb_rpc, sb_get, llm, AGENT_MODEL, GRADER_MODEL, LLM_PROVIDER, EMBED_MODEL
from grader import Grade, GradeStatus, grade_llm, grade_anchored, aggregate

HERE = Path(__file__).resolve().parent

AGENT_SYS = (
    "You are a home-lab troubleshooting assistant. Diagnose the user's problem and give "
    "a concrete, step-by-step fix. If CONTEXT (documentation or recalled memory) is provided, "
    "ground your answer in it. Do NOT invent specific file paths, IPs, ports, commands, or "
    "version numbers you were not given and are not sure of — if you don't know a specific, say "
    "so rather than guessing. Be concise and practical."
)


def build_context(condition: str, scenario: dict, k: int):
    """Return (context_text, retrieved_names)."""
    if condition == "blind":
        return "", []
    if condition == "docs":
        return scenario.get("docs_context", ""), ["<static docs corpus>"]
    if condition == "memory":
        emb = embed(scenario["user_report"])
        res = sb_rpc("hybrid_recall", {
            "p_query_text": scenario["user_report"],
            "p_query_embedding": json.dumps(emb),
            "p_match_threshold": 0.3, "p_match_count": k, "p_filter_type": None,
        })
        ids = [r["id"] for r in res][:k]
        rows = sb_get("memories", {"id": f"in.({','.join(ids)})",
                                   "select": "id,name,description,content"}) if ids else []
        by = {r["id"]: r for r in rows}
        ordered = [by[i] for i in ids if i in by]
        blocks, names = [], []
        for m in ordered:
            names.append(m["name"])
            blocks.append(f"### {m['name']}\n{m.get('description','')}\n{(m.get('content') or '').strip()}")
        return "\n\n".join(blocks), names
    die(f"unknown condition: {condition}")


def die(m):
    print(f"ERROR: {m}", file=sys.stderr); sys.exit(1)


def agent_respond(scenario: dict, context: str) -> str:
    user = (f"PROBLEM REPORT:\n{scenario['user_report']}\n\n"
            + (f"CONTEXT:\n{context}\n\n" if context else "")
            + "Give your diagnosis and the exact steps to fix it.")
    return llm([{"role": "system", "content": AGENT_SYS}, {"role": "user", "content": user}],
               model=AGENT_MODEL, max_tokens=700, temperature=0.4)


# Grading moved to grader.py (2026-08-07, eval TIER 3).
#
# What used to live here was a line-format regex parse whose else-branch was
# `dims[k] = 0`. A grade that failed to PARSE was recorded as a grade of ZERO and
# then averaged in, which is why eval/STATUS.md logged "scores clearly-correct
# answers near zero" as the project's #1 blocker for three weeks. Measured on the
# fixtures in fixtures/homebridge_alexa_cookie_grader.json, the old path parsed
# 0/5 rubric dimensions on one fixture and 2/5 on two more — the scores it
# reported for those were parse artifacts, not judgements.
#
# grade_llm() uses constrained decoding and returns a STATUS; an unparseable grade
# is INVALID and is excluded from the mean rather than being counted as zero.
# grade_anchored() is the LLM-free deterministic cross-check.
def grade(scenario: dict, answer: str) -> dict:
    """Back-compat shim: same dict shape the rest of this file already consumes."""
    g = grade_llm(scenario, answer, llm, GRADER_MODEL)
    a = grade_anchored(scenario, answer)
    d = g.to_json()
    d["parsed_dims"] = len(g.dims) if g.valid else 0
    d["anchored_score"] = a.score if a.valid else None
    d["anchored_dims"] = a.dims if a.valid else None
    return d


def cmd_run(args):
    scenario = json.loads((HERE / args.scenario).read_text())
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    outdir = HERE / "results" / args.tag
    outdir.mkdir(parents=True, exist_ok=True)
    rows_f = (outdir / "rows.jsonl").open("w")
    samples = {}

    print(f"Scenario: {scenario['title']}\nConditions: {conditions} × {args.reps} reps "
          f"(agent={AGENT_MODEL}, provider={LLM_PROVIDER})\n")

    agg = {c: {"scores": [], "anchored": [], "dims": {k: [] for k in scenario["rubric"]},
               "recall": None, "names": [], "grades": []}
           for c in conditions}

    for cond in conditions:
        for rep in range(args.reps):
            ctx, names = build_context(cond, scenario, args.k)
            if cond == "memory":
                agg[cond]["names"] = names
                gold_hit = any("homebridge-alexa-cookie" in n.lower() or "cookie-expiry" in n.lower()
                               or ("homebridge" in n.lower() and "alexa" in n.lower()) for n in names)
                agg[cond]["recall"] = bool(agg[cond]["recall"]) or gold_hit
            ans = agent_respond(scenario, ctx)

            g = grade_llm(scenario, ans, llm, GRADER_MODEL)
            a = grade_anchored(scenario, ans)
            agg[cond]["grades"].append(g)
            if a.valid:
                agg[cond]["anchored"].append(a.score)

            # An INVALID grade contributes nothing. This is the fix: it used to
            # contribute 0.0, which is a claim about the ANSWER when it is really
            # a fact about the GRADER.
            if g.valid:
                agg[cond]["scores"].append(g.score)
                for k in scenario["rubric"]:
                    agg[cond]["dims"][k].append(g.dims[k])

            samples.setdefault(cond, {"answer": ans, "grade": g.to_json(),
                                      "anchored": a.to_json(), "ctx_chars": len(ctx)})
            rows_f.write(json.dumps({"condition": cond, "rep": rep,
                                     "score": g.score if g.valid else None,
                                     "status": g.status.value, "detail": g.detail,
                                     "anchored_score": a.score if a.valid else None,
                                     "dims": g.dims if g.valid else None,
                                     "anchored_dims": a.dims if a.valid else None,
                                     "notes": g.notes, "ctx_chars": len(ctx),
                                     "retrieved": names if cond == "memory" else None}) + "\n")
            if g.valid:
                print(f"  {cond:7} rep{rep+1}: llm {g.score:.2f}  anchored {a.score:.2f}  "
                      + " ".join(f"{k}={g.dims[k]}" for k in scenario['rubric'])
                      + f"  — {g.notes[:60]}")
            else:
                print(f"  {cond:7} rep{rep+1}: llm INVALID ({g.status.value})  "
                      f"anchored {a.score:.2f}  — {g.detail[:70]}")
    rows_f.close()

    report = render(scenario, conditions, agg, samples, args)
    (outdir / "report.md").write_text(report)
    (outdir / "samples.json").write_text(json.dumps(samples, indent=2))
    print("\n" + report)
    print(f"\nRows: {outdir/'rows.jsonl'}\nSamples: {outdir/'samples.json'}\nReport: {outdir/'report.md'}")


def _mean(xs):
    return round(sum(xs) / len(xs), 3) if xs else 0.0


def render(scenario, conditions, agg, samples, args):
    rub = scenario["rubric"]
    L = [f"# Scenario eval — {scenario['title']}", ""]
    L.append(f"- agent/grader: `{AGENT_MODEL}` (provider `{LLM_PROVIDER}`) · retrieval: `{EMBED_MODEL}`+`hybrid_recall` · reps={args.reps}, k={args.k}")
    L.append(f"- grading vs GOLD reference across {len(rub)} rubric dims (max {sum(v['max'] for v in rub.values())} pts)")
    L.append("")
    header = ("| condition | overall (llm) | anchored | graded | "
              + " | ".join(rub.keys()) + " | recall |")
    L.append(header)
    L.append("|" + "---|" * (len(rub) + 5))
    voids = []
    for c in conditions:
        dims = " | ".join(f"{_mean(agg[c]['dims'][k]):.1f}/{rub[k]['max']}" for k in rub)
        rec = "—" if agg[c]["recall"] is None else ("✓" if agg[c]["recall"] else "✗")
        stats = aggregate(agg[c]["grades"])
        if stats["void"]:
            voids.append((c, stats["void_reason"]))
        overall = "VOID" if stats["void"] else f"**{stats['mean_score']:.2f}**"
        anch = f"{_mean(agg[c]['anchored']):.2f}" if agg[c]["anchored"] else "—"
        L.append(f"| {c} | {overall} | {anch} | {stats['n_valid']}/{stats['n']} | {dims} | {rec} |")
    L.append("")
    L.append("- **graded** = grades that actually parsed. An unparseable grade is excluded, "
             "never counted as 0 — see grader.py.")
    if voids:
        L.append("")
        L.append("> **RUN VOID** for: " + "; ".join(f"`{c}` ({why})" for c, why in voids))
        L.append("> The grader did not return usable judgements for these conditions. "
                 "Read the `anchored` column, which needs no LLM, and re-run "
                 "`python3 grader.py calibrate` before trusting anything here.")
    L.append("")
    # Δ is computed on the ANCHORED score, not the LLM score. It is deterministic
    # and needs no model, so a conclusion drawn from it survives the grader model
    # being swapped, rate-limited, or having a bad day — which the headline
    # comparison in this eval has to.
    def _anch(c):
        return _mean(agg[c]["anchored"]) if agg[c]["anchored"] else None

    base = _anch(conditions[0]) if conditions else None
    L.append("## Read (anchored — deterministic, no LLM)")
    for c in conditions:
        v = _anch(c)
        if v is None:
            L.append(f"- **{c}: no anchored score** (scenario has no `anchors` block)")
            continue
        delta = ("  (baseline)" if c == conditions[0] or base is None
                 else f"  (Δ vs {conditions[0]} = {v - base:+.2f})")
        llm_stats = aggregate(agg[c]["grades"])
        llm_note = ("llm VOID" if llm_stats["void"]
                    else f"llm {llm_stats['mean_score']:.2f} on {llm_stats['n_valid']}/{llm_stats['n']}")
        L.append(f"- **{c}: {v:.2f}**{delta}  ·  {llm_note}")
    if "memory" in agg and agg["memory"]["names"]:
        L.append(f"- memory retrieved: {', '.join(agg['memory']['names'][:6])}")
    L.append("")
    L.append("## Sample answers (rep 1, truncated)")
    for c in conditions:
        s = samples.get(c, {})
        ans = (s.get("answer", "") or "")[:700]
        L.append(f"### {c} — scored {s.get('grade',{}).get('score','?')}")
        L.append("```")
        L.append(ans + ("…" if len(s.get("answer", "")) > 700 else ""))
        L.append("```")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="Troubleshooting scenario eval across knowledge substrates")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--scenario", default="scenarios/homebridge_alexa.json")
    r.add_argument("--conditions", default="blind,docs,memory")
    r.add_argument("--reps", type=int, default=3)
    r.add_argument("--k", type=int, default=6)
    r.add_argument("--tag", default="scenario1")
    r.set_defaults(func=cmd_run)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
