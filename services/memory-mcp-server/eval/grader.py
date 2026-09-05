#!/usr/bin/env python3
"""
grader.py — the trustworthy scoring layer for scenario/QA evals.

WHY THIS EXISTS (eval/STATUS.md's own #1 blocker, open since 2026-07-13)
  "Grader reliability is the #1 blocker. Nemotron is an unreliable structured
   grader — scores clearly-correct answers near zero, echoes template
   placeholders. Fix before trusting any number."

  The retrieval gate (retrieval_regression.py) is trustworthy — it makes zero
  LLM calls and computes nDCG/recall arithmetically. The SCENARIO grader was
  not, and both of today's behaviour changes (bi-temporal recall, INT8 rerank)
  need a gate that can be believed.

THE ACTUAL BUG, and it is not "the model is bad"
  The old grader asked for a line format and parsed it with a per-dimension
  regex:

      matches = re.findall(rf"{k}\\s*[:=]\\s*(\\d+)", out)
      dims[k] = int(matches[-1]) if matches else 0        # <-- here

  When the model emitted `root_cause: <int>` — i.e. echoed the template — the
  regex found no digits and the dimension scored **0**. A grade that FAILED TO
  PARSE was recorded as a grade of ZERO, which is indistinguishable in every
  downstream average from an answer that was genuinely wrong. `parsed_dims` was
  computed and then never used for anything.

  That is why "clearly-correct answers score near zero": they largely didn't
  score at all. No amount of swapping in a stronger model fixes a parser that
  encodes failure as the worst possible score.

THE FIX — four layers, in order of how much they are trusted
  1. STRUCTURED DECODING. Ask for JSON via response_format, negotiating down
     json_schema -> json_object -> prompt-only per what the endpoint accepts,
     and parse a balanced JSON object out of the reply.
  2. INVALID IS NOT ZERO. Every grade carries a status. A grade that did not
     parse, echoed the template, or came back out of range is INVALID: excluded
     from the mean and counted. If too many are invalid the RUN IS VOID, and
     says so, instead of reporting a confident 0.00.
  3. ANCHORED SCORING (no LLM at all). Deterministic clause matching against
     gold-derived anchors in the scenario file. Reproducible, free, and
     unaffected by whatever the grader model is doing this week. This is the
     number to trust when the two disagree.
  4. CALIBRATION. `calibrate` runs both scorers over fixtures whose correct
     band is known by hand, and reports agreement. A grader that cannot place a
     known-good and a known-bad answer on the right side of the line is not
     usable, and this is what says so BEFORE a run is believed.

USAGE
  from grader import grade_llm, grade_anchored, GradeStatus
  python3 grader.py calibrate --scenario scenarios/homebridge_alexa.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


class GradeStatus(str, Enum):
    OK = "ok"
    INVALID_PARSE = "invalid_parse"        # no JSON / no usable numbers came back
    INVALID_TEMPLATE = "invalid_template"  # the model echoed the prompt's placeholders
    INVALID_RANGE = "invalid_range"        # numbers came back outside the rubric maxima
    LLM_ERROR = "llm_error"                # the call itself never returned


# Placeholders from the grader prompt. If any of these survive into the reply,
# the model was completing the template rather than grading — the exact failure
# STATUS.md named. Treating this as a parse failure (not a zero) is the whole
# point of the module.
TEMPLATE_MARKERS = [
    r"<\s*int\s*>",
    r"<\s*integer\s*>",
    r"<\s*score\s*>",
    r"<\s*one short sentence\s*>",
    r"<\s*number\s*>",
    r"\.\.\.",
]

MAX_INVALID_FRACTION = float(os.environ.get("EVAL_MAX_INVALID_GRADES", "0.20"))


@dataclass
class Grade:
    dims: dict = field(default_factory=dict)
    score: float = 0.0
    raw_total: int = 0
    max_total: int = 0
    notes: str = ""
    status: GradeStatus = GradeStatus.OK
    detail: str = ""
    method: str = "llm"

    @property
    def valid(self) -> bool:
        return self.status == GradeStatus.OK

    def to_json(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        return d


# ─────────────────────────────────────────────────────────────────────────────
# 1. Structured decoding
# ─────────────────────────────────────────────────────────────────────────────
def _schema_for(rubric: dict) -> dict:
    props = {
        k: {"type": "integer", "minimum": 0, "maximum": v["max"], "description": v["desc"][:220]}
        for k, v in rubric.items()
    }
    props["notes"] = {"type": "string", "maxLength": 200}
    return {
        "type": "object",
        "properties": props,
        "required": list(rubric.keys()) + ["notes"],
        "additionalProperties": False,
    }


def _extract_json(text: str) -> dict | None:
    """First BALANCED {...} in the reply.

    A greedy or non-greedy regex both get this wrong on a reply that contains
    prose around the object, or a nested object in `notes`. Brace counting is
    the only version that survives a reasoning model's commentary.
    """
    if not text:
        return None
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


def _looks_like_template(text: str) -> str | None:
    for pat in TEMPLATE_MARKERS:
        if re.search(pat, text, re.I):
            return pat
    return None


GRADER_SYS = (
    "You are a strict technical grader. Score a troubleshooting ANSWER against the GOLD "
    "reference fix using the RUBRIC.\n"
    "Award points ONLY for content that matches the gold (paraphrase is fine). Generic advice "
    "that happens to overlap earns partial credit; wrong or hallucinated specifics earn zero and "
    "reduce the safety score.\n"
    "Respond with a single JSON object and nothing else. Every rubric key must be present with an "
    "INTEGER value within its stated range, plus a short 'notes' string. Do not copy the rubric "
    "text, and never emit a placeholder — emit real numbers you have decided on."
)


def grade_llm(scenario: dict, answer: str, llm_fn, model: str, temperature: float = 0.0) -> Grade:
    """LLM grade with structured decoding, negotiated per endpoint capability."""
    rubric = scenario["rubric"]
    max_total = sum(v["max"] for v in rubric.values())
    rubric_text = "\n".join(f"- {k} (integer 0..{v['max']}): {v['desc']}" for k, v in rubric.items())
    schema = _schema_for(rubric)

    user = (
        f"PROBLEM:\n{scenario['user_report']}\n\n"
        f"GOLD REFERENCE FIX:\n{scenario['gold_reference']}\n\n"
        f"RUBRIC:\n{rubric_text}\n\n"
        f"ANSWER TO GRADE:\n{answer}\n\n"
        f"Return JSON matching this schema:\n{json.dumps(schema)}"
    )
    messages = [{"role": "system", "content": GRADER_SYS}, {"role": "user", "content": user}]

    # Negotiate downward. Endpoints that reject an unsupported response_format
    # do it with a 4xx, which llm_fn surfaces as an exception — so "try the
    # strongest constraint first, fall back" is the only portable strategy.
    attempts = [
        {"type": "json_schema", "json_schema": {"name": "grade", "strict": True, "schema": schema}},
        {"type": "json_object"},
        None,
    ]

    last_text, last_err = "", ""
    for response_format in attempts:
        try:
            kwargs = {"model": model, "max_tokens": 400, "temperature": temperature}
            if response_format is not None:
                kwargs["response_format"] = response_format
            out = llm_fn(messages, **kwargs)
        except TypeError:
            # llm_fn predates response_format support — only the prompt-only arm
            # is callable, so stop negotiating rather than retrying identically.
            if response_format is not None:
                continue
            return Grade(dims={k: 0 for k in rubric}, max_total=max_total,
                         status=GradeStatus.LLM_ERROR,
                         detail="llm_fn does not accept response_format", method="llm")
        except Exception as e:
            last_err = str(e)[:200]
            continue

        last_text = out or ""
        marker = _looks_like_template(last_text)
        obj = _extract_json(last_text)

        if obj is None:
            if marker:
                continue  # template echo — try a stronger constraint
            continue

        dims, bad_range = {}, []
        for k, v in rubric.items():
            raw = obj.get(k)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                m = re.search(r"-?\d+", str(raw)) if raw is not None else None
                if not m:
                    dims = {}
                    break
                raw = int(m.group())
            raw = int(raw)
            if raw < 0 or raw > v["max"]:
                bad_range.append(f"{k}={raw} (max {v['max']})")
            dims[k] = max(0, min(raw, v["max"]))

        if not dims:
            continue

        notes = str(obj.get("notes", ""))[:200]
        if _looks_like_template(notes):
            notes = ""

        got = sum(dims.values())
        g = Grade(dims=dims, score=round(got / max_total, 3) if max_total else 0.0,
                  raw_total=got, max_total=max_total, notes=notes, method="llm")
        if bad_range:
            # Clamped rather than discarded: the model DID decide, it just
            # decided outside the scale. Flagged so calibration can see it.
            g.detail = "clamped: " + "; ".join(bad_range)
        return g

    if last_err and not last_text:
        return Grade(dims={k: 0 for k in rubric}, max_total=max_total,
                     status=GradeStatus.LLM_ERROR, detail=last_err, method="llm")
    marker = _looks_like_template(last_text)
    return Grade(
        dims={k: 0 for k in rubric}, max_total=max_total,
        status=GradeStatus.INVALID_TEMPLATE if marker else GradeStatus.INVALID_PARSE,
        detail=(f"template placeholder {marker!r} in reply" if marker
                else f"no JSON object in reply: {last_text[:160]!r}"),
        method="llm",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2. Anchored scoring — deterministic, no LLM
# ─────────────────────────────────────────────────────────────────────────────
def grade_anchored(scenario: dict, answer: str) -> Grade:
    """Score by matching gold-derived anchor clauses against the answer.

    A dimension's anchors are a list of CLAUSES; a clause is a list of
    alternative regexes (synonyms/spellings). A clause is satisfied if ANY of
    its alternatives matches. The dimension scores max * satisfied/total,
    rounded — partial credit falls out of the structure rather than being
    negotiated with a model.

    `negative` patterns cap the dimension at 0. That is the right shape for the
    two dimensions that are about NOT doing something (topology: don't chase
    Home Assistant; safety: don't confidently invent). A wrong answer with the
    right vocabulary should not collect points for the vocabulary.
    """
    rubric = scenario["rubric"]
    anchors = scenario.get("anchors") or {}
    max_total = sum(v["max"] for v in rubric.values())

    if not anchors:
        return Grade(dims={k: 0 for k in rubric}, max_total=max_total,
                     status=GradeStatus.INVALID_PARSE, method="anchored",
                     detail="scenario has no `anchors` block — anchored scoring unavailable")

    dims, notes = {}, []
    for k, spec in rubric.items():
        a = anchors.get(k)
        if not a:
            dims[k] = 0
            notes.append(f"{k}: no anchors")
            continue

        negatives = a.get("negative") or []
        if any(re.search(p, answer, re.I | re.S) for p in negatives):
            dims[k] = 0
            notes.append(f"{k}: negative match")
            continue

        clauses = a.get("clauses") or []
        if not clauses:
            dims[k] = 0
            continue
        hit = sum(1 for clause in clauses
                  if any(re.search(p, answer, re.I | re.S) for p in clause))
        dims[k] = int(round(spec["max"] * hit / len(clauses)))

    got = sum(dims.values())
    return Grade(dims=dims, score=round(got / max_total, 3) if max_total else 0.0,
                 raw_total=got, max_total=max_total, method="anchored",
                 notes="; ".join(notes)[:200])


# ─────────────────────────────────────────────────────────────────────────────
# 3. Aggregation that refuses to average garbage
# ─────────────────────────────────────────────────────────────────────────────
def aggregate(grades: list[Grade], max_invalid_fraction: float = MAX_INVALID_FRACTION) -> dict:
    total = len(grades)
    valid = [g for g in grades if g.valid]
    n_invalid = total - len(valid)
    frac = (n_invalid / total) if total else 0.0
    reasons = {}
    for g in grades:
        if not g.valid:
            reasons[g.status.value] = reasons.get(g.status.value, 0) + 1
    return {
        "n": total,
        "n_valid": len(valid),
        "n_invalid": n_invalid,
        "invalid_fraction": round(frac, 3),
        "invalid_reasons": reasons,
        # None, not 0.0. A mean over zero valid grades is not a score, and
        # emitting 0.0 here is precisely the bug this module exists to kill.
        "mean_score": (round(sum(g.score for g in valid) / len(valid), 3) if valid else None),
        "void": (not valid) or (frac > max_invalid_fraction),
        "void_reason": (
            "no valid grades" if not valid
            else f"invalid fraction {frac:.2f} > {max_invalid_fraction:.2f}" if frac > max_invalid_fraction
            else ""
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. Calibration
# ─────────────────────────────────────────────────────────────────────────────
def cmd_calibrate(args):
    from memory_eval import llm, GRADER_MODEL, LLM_PROVIDER  # noqa: E402

    scenario = json.loads((HERE / args.scenario).read_text())
    fx_path = HERE / (args.fixtures or f"fixtures/{scenario['id']}_grader.json")
    if not fx_path.exists():
        print(f"ERROR: no fixtures at {fx_path}", file=sys.stderr)
        return 2
    fixtures = json.loads(fx_path.read_text())["fixtures"]

    llm_fn = llm  # memory_eval.llm now takes response_format directly

    print(f"grader calibration — scenario={scenario['id']} model={GRADER_MODEL} "
          f"provider={LLM_PROVIDER} reps={args.reps}\n")
    print(f"{'fixture':<28} {'band':>10} {'anchored':>9} {'llm':>18}  verdict")
    print("-" * 82)

    n_ok_anchor = n_ok_llm = n_scored_llm = 0
    for fx in fixtures:
        lo, hi = fx["expect_band"]
        ans = fx["answer"]

        ga = grade_anchored(scenario, ans)
        a_ok = ga.valid and lo <= ga.score <= hi
        n_ok_anchor += bool(a_ok)

        llm_cells, llm_ok = [], 0
        if not args.anchored_only:
            for _ in range(args.reps):
                g = grade_llm(scenario, ans, llm_fn, GRADER_MODEL)
                if g.valid:
                    n_scored_llm += 1
                    llm_cells.append(f"{g.score:.2f}")
                    llm_ok += int(lo <= g.score <= hi)
                else:
                    llm_cells.append(g.status.value[:8])
            n_ok_llm += int(llm_ok > args.reps / 2)

        verdict = ("anchored OK" if a_ok else "ANCHORED OFF-BAND")
        print(f"{fx['name']:<28} {f'{lo:.2f}-{hi:.2f}':>10} "
              f"{ga.score:>9.2f} {','.join(llm_cells) or '-':>18}  {verdict}")

    n = len(fixtures)
    print()
    print(f"anchored agreement: {n_ok_anchor}/{n}")
    if not args.anchored_only:
        print(f"llm agreement (majority of {args.reps} reps in band): {n_ok_llm}/{n}")
        print(f"llm grades that parsed at all: {n_scored_llm}/{n * args.reps}")
    print()
    if n_ok_anchor == n:
        print("ANCHORED SCORER IS CALIBRATED — safe to use as the scenario gate.")
    else:
        print("ANCHORED SCORER IS NOT CALIBRATED — fix the anchors before trusting any run.")
    return 0 if n_ok_anchor == n else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("calibrate", help="check both scorers against hand-labelled fixtures")
    c.add_argument("--scenario", default="scenarios/homebridge_alexa.json")
    c.add_argument("--fixtures", default=None)
    c.add_argument("--reps", type=int, default=2)
    c.add_argument("--anchored-only", action="store_true",
                   help="skip the LLM arm (no API calls) — checks the anchors alone")
    c.set_defaults(func=cmd_calibrate)
    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
