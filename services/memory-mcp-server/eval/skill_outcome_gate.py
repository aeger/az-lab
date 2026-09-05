#!/usr/bin/env python3
"""
Skill outcome assertion — the nightly check that the procedural-memory loop is alive.

WHY THIS EXISTS (2026-08-04 research, TIER 1)
  record_skill_outcome has existed since migration 080 and is wired into both
  poll_queue.py and src/index.ts. On 2026-08-04 exactly 2 of 32 skills carried any
  outcome data. The plumbing was never the problem; nothing asserted on the plumbing
  being used, so nobody noticed it wasn't. Same failure shape as the retrieval
  harness before nightly_eval.sh: a thing you remember to check is a thing nobody
  checks.

  Migration 104 backfilled 39 terminal agent_episodes into the counters. That fixes
  the cold-start problem for the monthly refine pass — it does NOT fix the live
  reporting loop, and the distinction is the whole point of this gate.

WHAT IT ASSERTS
  A skill with evidence of use and ZERO live outcomes is flagged.

  "Live" means outcomes minus migration 104's seeded counts. Asserting on the raw
  total would go green the moment the backfill landed and stay green forever while
  Atlas and Iris carried on never self-reporting — the backfill would have bought a
  passing metric instead of a working loop.

  "Evidence of use" pools every signal that exists: recall_skill bumps use_count,
  the poller stamps context.skill_name on the task row, and the backfill ledger
  records replayed episodes. Any one of them means the skill is being selected in
  the field. All three are summed in the skill_outcome_gaps view (migration 104).

  Separately it reports skills with NO triggers. Those are invisible to
  poll_queue.py::_match_skill by construction, so they can never be auto-attributed
  no matter how often they are used — a starved skill and an unreachable skill need
  different fixes, and lumping them together hides the second kind.

EXIT CODE
  Always 0 unless --strict. This is telemetry about the skill loop, not about
  retrieval: a starved counter must not turn the nightly retrieval gate red, or the
  signal that matters gets lost behind the signal that does not. nightly_eval.sh
  calls it without --strict and discards the code.
"""
import argparse
import os
import sys
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
SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(path: str, params: dict) -> list:
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS,
                  params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def discord(msg: str) -> bool:
    """Same path as retrieval_regression.py::discord — notify.send() via agent-bus.
    A dead bus must never change this script's verdict."""
    try:
        sys.path.insert(0, os.path.expanduser("~/claude/agent-bus"))
        import notify
        return bool(notify.send(msg, channel="claude-code"))
    except Exception as e:
        print(f"  ! Discord alert failed ({e}) — verdict still stands", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-evidence", type=int, default=3,
                    help="flag a skill once it has this many uses with zero live outcomes "
                         "(default 3 — below that, silence is just a quiet skill)")
    ap.add_argument("--notify", action="store_true",
                    help="post the flagged summary to Discord #claude-code")
    ap.add_argument("--notify-ok", action="store_true",
                    help="post even when nothing is flagged")
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 when anything is flagged (default: always exit 0)")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SECRET_KEY not set", file=sys.stderr)
        return 2

    rows = sb_get("skill_outcome_gaps", {"select": "*", "order": "evidence_count.desc"})
    starved = [r for r in rows
               if r["evidence_count"] >= args.min_evidence and r["live_outcomes"] == 0]

    # Unreachable skills: no triggers at all, so _match_skill can never name them.
    untriggered = sb_get("skills", {"select": "name,triggers,use_count",
                                    "or": "(triggers.is.null,triggers.eq.{})"})

    total = len(rows)
    with_outcomes = sum(1 for r in rows if r["total_outcomes"] > 0)
    with_live = sum(1 for r in rows if r["live_outcomes"] > 0)

    print(f"=== skill outcome gate  (min-evidence={args.min_evidence}) ===")
    print(f"  skills: {total}  with any outcome: {with_outcomes}  with LIVE outcome: {with_live}")
    print(f"  starved (used >= {args.min_evidence}, zero live outcomes): {len(starved)}")
    for r in starved:
        print(f"    - {r['name']}: evidence={r['evidence_count']} "
              f"(recall {r['recall_use_count']} / tasks {r['tasks_attributed']} / "
              f"backfilled {r['backfilled_episodes']}), total_outcomes={r['total_outcomes']}, live=0")
    print(f"  unreachable (no triggers, cannot be auto-attributed): {len(untriggered)}")
    for s in untriggered:
        print(f"    - {s['name']}")

    if starved and (args.notify or args.notify_ok):
        names = ", ".join(f"`{r['name']}`" for r in starved[:8])
        more = f" (+{len(starved) - 8} more)" if len(starved) > 8 else ""
        discord(
            f"🧩 **Skill outcome loop starved** — {len(starved)} skill(s) used "
            f"≥{args.min_evidence}× with zero *live* self-reports: {names}{more}\n"
            f"Live reporting: {with_live}/{total} skills. "
            f"{len(untriggered)} skill(s) have no triggers and can never be auto-attributed."
        )
    elif not starved and args.notify_ok:
        discord(f"🧩 Skill outcome loop OK — {with_live}/{total} skills carry live outcomes, "
                f"none starved at ≥{args.min_evidence} uses.")

    return 1 if (starved and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
