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
import re
import sys
import time
from pathlib import Path

# reuse the validated low-level clients + config from memory_eval
from memory_eval import embed, sb_rpc, sb_get, llm, AGENT_MODEL, GRADER_MODEL, LLM_PROVIDER, EMBED_MODEL

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


GRADER_SYS = (
    "You are a strict technical grader. Score a troubleshooting ANSWER against the GOLD "
    "reference fix using the RUBRIC. Award points only for content that matches the gold "
    "(paraphrase ok). Generic advice that happens to overlap earns partial credit; wrong or "
    "hallucinated specifics earn zero and hurt the safety score.\n"
    "Output ONLY the score lines below — one per rubric dimension, then a one-line note. "
    "No reasoning, no preamble, no other text. Exactly this format:\n"
    "root_cause: <int>\nfix_correct: <int>\nspecificity: <int>\ntopology: <int>\n"
    "safety: <int>\nnotes: <one short sentence>"
)


def grade(scenario: dict, answer: str) -> dict:
    rub = scenario["rubric"]
    rubric_text = "\n".join(f"- {k} (0..{v['max']}): {v['desc']}" for k, v in rub.items())
    user = (f"PROBLEM:\n{scenario['user_report']}\n\nGOLD REFERENCE FIX:\n{scenario['gold_reference']}\n\n"
            f"RUBRIC:\n{rubric_text}\n\nANSWER TO GRADE:\n{answer}")
    out = llm([{"role": "system", "content": GRADER_SYS}, {"role": "user", "content": user}],
              model=GRADER_MODEL, max_tokens=300, temperature=0.0)
    # Line-format parse — robust to reasoning-model preambles (take the LAST int per key).
    dims, parsed = {}, 0
    for k, v in rub.items():
        matches = re.findall(rf"{re.escape(k)}\s*[:=]\s*(\d+)", out, re.I)
        if matches:
            dims[k] = max(0, min(int(matches[-1]), v["max"]))
            parsed += 1
        else:
            dims[k] = 0
    nm = re.search(r"notes\s*[:=]\s*(.+)", out, re.I)
    notes = (nm.group(1).strip()[:160] if nm else "")
    maxtot = sum(v["max"] for v in rub.values())
    got = sum(dims.values())
    return {"dims": dims, "score": round(got / maxtot, 3), "raw_total": got, "max_total": maxtot,
            "notes": notes, "parsed_dims": parsed}


def cmd_run(args):
    scenario = json.loads((HERE / args.scenario).read_text())
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    outdir = HERE / "results" / args.tag
    outdir.mkdir(parents=True, exist_ok=True)
    rows_f = (outdir / "rows.jsonl").open("w")
    samples = {}

    print(f"Scenario: {scenario['title']}\nConditions: {conditions} × {args.reps} reps "
          f"(agent={AGENT_MODEL}, provider={LLM_PROVIDER})\n")

    agg = {c: {"scores": [], "dims": {k: [] for k in scenario["rubric"]}, "recall": None, "names": []}
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
            g = grade(scenario, ans)
            agg[cond]["scores"].append(g["score"])
            for k in scenario["rubric"]:
                agg[cond]["dims"][k].append(g["dims"][k])
            samples.setdefault(cond, {"answer": ans, "grade": g, "ctx_chars": len(ctx)})
            rows_f.write(json.dumps({"condition": cond, "rep": rep, "score": g["score"],
                                     "dims": g["dims"], "notes": g["notes"], "ctx_chars": len(ctx),
                                     "retrieved": names if cond == "memory" else None}) + "\n")
            print(f"  {cond:7} rep{rep+1}: {g['score']:.2f}  "
                  + " ".join(f"{k}={g['dims'][k]}" for k in scenario['rubric']) + f"  — {g['notes'][:70]}")
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
    header = "| condition | overall | " + " | ".join(rub.keys()) + " | recall |"
    L.append(header)
    L.append("|" + "---|" * (len(rub) + 3))
    for c in conditions:
        dims = " | ".join(f"{_mean(agg[c]['dims'][k]):.1f}/{rub[k]['max']}" for k in rub)
        rec = "—" if agg[c]["recall"] is None else ("✓" if agg[c]["recall"] else "✗")
        L.append(f"| {c} | **{_mean(agg[c]['scores']):.2f}** | {dims} | {rec} |")
    L.append("")
    base = _mean(agg[conditions[0]]["scores"]) if conditions else 0
    L.append("## Read")
    for c in conditions:
        L.append(f"- **{c}: {_mean(agg[c]['scores']):.2f}**"
                 + (f"  (Δ vs {conditions[0]} = {_mean(agg[c]['scores'])-base:+.2f})" if c != conditions[0] else "  (baseline)"))
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
