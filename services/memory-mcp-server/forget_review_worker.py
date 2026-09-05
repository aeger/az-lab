#!/usr/bin/env python3
"""
Mutation-time forgetting adjudicator — the async half of migration 092.

WHY THIS EXISTS
---------------
"Control-Plane Placement Shapes Forgetting" (arXiv 2606.15903) measures where the
LLM sits relative to the CONTROL plane rather than the recall plane:

  deterministic primitives   5% identifier obfuscation, 0% cross-lingual
  inscribe-time LLM          100% canonicalization, 0% intent-aware deletion
  mutation-time hook         78-85% intent-aware deletion, 91.7-93.2% overall, 2.3s

az-lab's control plane was entirely the first row: SQL predicates in 073
(supersession), 085 (staleness), 065 (retirement). This worker adds the third.

WHY IT IS A SEPARATE PROCESS AND NOT A TRIGGER
----------------------------------------------
The recommendation said "wrap forget/supersede/retirement-execute in a Nemotron
check". Literally, inside Postgres, that is not possible: plpgsql has no
synchronous HTTP, pg_net is fire-and-forget, and blocking a write on a 2.3 s
external model turns every nightly retirement sweep into a liveness risk.

So migration 092 split it. CAPTURE is a trigger — synchronous, in-DB, and
bypass-proof, which is the property that actually matters: retire_cold_memories(),
discard_redundant_memories() and every execute_sql caller bypass the MCP tool
layer, and a tool-layer-only hook would see almost none of the real traffic.
ADJUDICATION is here, asynchronous, reading forgetting_review_queue.

The LLM is deliberately NOT on the recall path. Recall latency is unchanged.

MODES
-----
Default is observe-only: forget_guard_settings.auto_revert_enabled starts false,
so a 'wrong' verdict is recorded but changes nothing. Flip it only after reading
a few dozen real verdicts. review_forget_mutation() enforces this server-side —
this worker cannot revert anything the DB has not been told to allow.

Usage:
  ./forget_review_worker.py                 # drain pending queue
  ./forget_review_worker.py --limit 20
  ./forget_review_worker.py --dry-run       # print verdicts, write nothing
  ./forget_review_worker.py --notify        # Discord summary
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx

ENV_FILE = Path(__file__).resolve().parent / ".env"


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
# Nemotron endpoint. Default is the direct NVIDIA NIM API, NOT .env's RERANK_URL.
# Checked 2026-07-31: RERANK_URL (http://192.168.1.183:8000, nemoclaw-01) refuses
# connections, while integrate.api.nvidia.com answers 200 and serves
# nemotron-3-super-120b-a12b. Since the MCP server's Nemotron RERANK fallback
# points at that same dead host, that fallback is currently dead too — recall is
# unaffected because local TEI is the primary reranker, but it is worth fixing.
# Direct NIM also matches the standing rule in CLAUDE.md ("use direct NVIDIA NIM
# API, key at ~/.nvidia_api_key").
LLM_URL = os.environ.get("FORGET_REVIEW_URL", "https://integrate.api.nvidia.com").rstrip("/")
KEY_FILE = Path.home() / ".nvidia_api_key"
NVIDIA_API_KEY = (
    os.environ.get("NVIDIA_API_KEY", "")
    or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
)
LLM_MODEL = os.environ.get("FORGET_REVIEW_MODEL", "nvidia/nemotron-3-super-120b-a12b")
AGENT_BUS_URL = os.environ.get("AGENT_BUS_URL", "http://localhost:8765")
AGENT_BUS_SECRET = os.environ.get("AGENT_BUS_SECRET", "")

SB_HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
              "Content-Type": "application/json"}

# The named failure modes from 2606.15903 §4. The adjudicator must pick one when
# it says 'wrong', which is what makes the eval probes in migration 093
# attributable — "FCFR moved" is not actionable, "compound_fact is leaking" is.
FAILURE_MODES = [
    "identifier_obfuscation",  # same entity, different surface form (IP vs hostname vs alias)
    "cross_lingual",           # same fact stated in another language
    "prefix_collision",        # deleted a sibling that merely shares a name prefix
    "compound_fact",           # removed a row carrying >1 fact to retire only one of them
    "lexical_categorization",  # matched on wording, not meaning
    "temporal_categorization", # confused "was true then" with "is wrong now"
    "none",
]


def sb_get(path: str, params: dict):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS,
                  params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def rpc(fn: str, body: dict):
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", headers=SB_HEADERS,
                   json=body, timeout=60)
    r.raise_for_status()
    return r.json() if r.text else None


def settings() -> dict:
    rows = sb_get("forget_guard_settings", {"select": "*", "limit": "1"})
    return rows[0] if rows else {}


PROMPT = """You are auditing a memory-deletion decision in an agent memory system.

A deterministic SQL rule removed a memory from retrieval. Deterministic rules are
good at "this row is old" and bad at "removing this row loses information the
system still needs". Your job is only the second question.

MUTATION
  operation:        {op}
  memory name:      {name}
  memory type:      {mtype}
  stated reason:    {reason}
  written by:       {writer} (db_user {db_user}, app {app})
  inbound/outbound links: {links}
  superseded by:    {superseded}

MEMORY CONTENT THAT WAS REMOVED
{content}

Decide:
- "approved"  — removing this was correct. It is obsolete, superseded, a duplicate,
                or a dated log entry whose content is captured elsewhere.
- "wrong"     — this removal loses a fact the system still needs. In particular:
                the row carries SEVERAL facts and only one was obsolete; or it is
                the only record of a credential location, hostname, IP, gotcha, or
                operational decision; or the "superseded by" target does not
                actually contain what this row contained.
- "uncertain" — genuinely cannot tell from the content shown.

If and only if the verdict is "wrong", name the failure mode from exactly this
list: {modes}

Answer with ONLY a JSON object, no prose, no markdown fence:
{{"verdict": "...", "failure_mode": "...", "confidence": 0.0-1.0, "reasoning": "one or two sentences"}}"""


def adjudicate(item: dict) -> dict | None:
    prompt = PROMPT.format(
        op=item.get("op"),
        name=item.get("memory_name"),
        mtype=item.get("memory_type"),
        reason=item.get("retire_reason") or "(none given)",
        writer=item.get("writer_agent") or "unknown",
        db_user=item.get("db_user"),
        app=item.get("app_name") or "unknown",
        links=item.get("link_count"),
        superseded=item.get("superseded_by_name") or "(nothing)",
        content=(item.get("content_excerpt") or "(empty)")[:4000],
        modes=", ".join(FAILURE_MODES),
    )
    try:
        r = httpx.post(
            f"{LLM_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {NVIDIA_API_KEY}",
                     "Content-Type": "application/json"},
            # nemotron-3-super is a REASONING model: it emits a long
            # chain-of-thought before the answer. At max_tokens=300 the reply was
            # truncated mid-reasoning and the JSON never arrived, which read as
            # "unparseable LLM reply" on every single item. Budget for the think.
            json={"model": LLM_MODEL,
                  "messages": [{"role": "user", "content": prompt}],
                  "temperature": 0, "max_tokens": 2048},
            timeout=120,
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  ! LLM call failed: {e}", file=sys.stderr)
        return None

    # The answer is the LAST JSON object in the reply, not the first: the
    # reasoning trace quotes the schema and the memory content, so an early or
    # greedy match lands on the model thinking out loud rather than on its answer.
    out = None
    for m in reversed(list(re.finditer(r"\{[^{}]*\}", text, re.S))):
        try:
            cand = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if "verdict" in cand:
            out = cand
            break
    if out is None:
        print(f"  ! unparseable LLM reply: {text[-200:]!r}", file=sys.stderr)
        return None

    if out.get("verdict") not in ("approved", "wrong", "uncertain"):
        return None
    # Fail SAFE, in the direction of keeping data: an unrecognised failure mode
    # downgrades to 'uncertain' rather than triggering a revert on a garbled reply.
    if out["verdict"] == "wrong" and out.get("failure_mode") not in FAILURE_MODES:
        out["failure_mode"] = None
    try:
        out["confidence"] = float(out.get("confidence", 0.0))
    except (TypeError, ValueError):
        out["confidence"] = 0.0
    return out


def send_discord(msg: str):
    try:
        httpx.post(f"{AGENT_BUS_URL}/message", json={"text": msg},
                   headers={"X-Agent-Secret": AGENT_BUS_SECRET}, timeout=15)
    except Exception as e:
        print(f"discord send failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--dry-run", action="store_true",
                    help="print verdicts without recording them")
    ap.add_argument("--notify", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("SUPABASE_URL / SUPABASE_SECRET_KEY missing (expected in ./.env)",
              file=sys.stderr)
        return 2
    if not NVIDIA_API_KEY:
        print("NVIDIA_API_KEY missing — cannot adjudicate", file=sys.stderr)
        return 2

    cfg = settings()
    if not cfg.get("llm_review_enabled", True):
        print("llm_review_enabled = false — nothing to do")
        return 0

    auto = cfg.get("auto_revert_enabled", False)
    print(f"=== forgetting adjudicator === model={LLM_MODEL} "
          f"auto_revert={'ON' if auto else 'OFF (observe-only)'}")

    queue = sb_get("forgetting_review_queue",
                   {"select": "*", "limit": str(args.limit)})
    if not queue:
        print("queue empty — nothing pending")
        return 0

    print(f"{len(queue)} pending mutation(s)\n")
    tally = {"approved": 0, "wrong": 0, "uncertain": 0, "failed": 0, "reverted": 0}
    modes: dict[str, int] = {}

    for item in queue:
        label = f"{item['op']:<11} {(item.get('memory_name') or '?')[:58]}"
        verdict = adjudicate(item)
        if verdict is None:
            tally["failed"] += 1
            print(f"  ?? {label}  (adjudication failed — left pending)")
            continue

        v, conf = verdict["verdict"], verdict["confidence"]
        tally[v] += 1
        if v == "wrong" and verdict.get("failure_mode"):
            modes[verdict["failure_mode"]] = modes.get(verdict["failure_mode"], 0) + 1

        mark = {"approved": "ok", "wrong": "XX", "uncertain": "--"}[v]
        print(f"  {mark} {label}  conf={conf:.2f} {verdict.get('failure_mode') or ''}")
        if v != "approved":
            print(f"       {verdict.get('reasoning', '')[:150]}")

        if args.dry_run:
            continue
        try:
            res = rpc("review_forget_mutation", {
                "p_audit_id": item["audit_id"],
                "p_verdict": v,
                "p_reasoning": verdict.get("reasoning"),
                "p_confidence": conf,
                "p_reviewer": LLM_MODEL,
                "p_failure_mode": verdict.get("failure_mode"),
            })
            if res and res.get("reverted"):
                tally["reverted"] += 1
                print("       -> REVERTED")
        except Exception as e:
            print(f"  ! recording verdict failed: {e}", file=sys.stderr)

    print(f"\napproved {tally['approved']} · wrong {tally['wrong']} · "
          f"uncertain {tally['uncertain']} · failed {tally['failed']} · "
          f"reverted {tally['reverted']}")
    if modes:
        print("failure modes: " + ", ".join(f"{k}={v}" for k, v in sorted(modes.items())))

    # Only ping on the case that needs a human: the control plane deleted
    # something it should not have. Silence otherwise.
    if args.notify and tally["wrong"]:
        send_discord(
            f"**Forgetting adjudicator** — {tally['wrong']} bad deletion(s) of "
            f"{len(queue)} reviewed"
            + (f", {tally['reverted']} auto-reverted" if tally["reverted"] else
               " (observe-only, nothing reverted)")
            + (f"\nfailure modes: {', '.join(f'{k}={v}' for k, v in sorted(modes.items()))}"
               if modes else "")
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
