#!/usr/bin/env python3
"""
Nightly memory lifecycle pass — the disposition half of the staleness loop.

Migration 057 built staleness DETECTION and 060 repaired it; neither built
disposition, so the flag fired into a queue that sat at 425 rows with a four-month
old head. This job is the missing verb (2026-07-23 research rec 1).

Each run:
  1. refresh the near-duplicate cluster cache
  2. re-assign hot/warm/cold tiers from the standing A-MAC composite
  3. report what WOULD be retired

Retirement itself stays double-gated: retire_cold_memories() dry-runs unless BOTH
--live is passed AND memory_lifecycle_settings.autoretire_enabled is true. Nothing
is ever hard-deleted; retirement is is_active=false and reverses via
unretire_memory().
"""
import argparse
import os
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
AGENT_BUS_URL = os.environ.get("AGENT_BUS_URL", "http://localhost:8765")
AGENT_BUS_SECRET = os.environ.get("AGENT_BUS_SECRET", "")

SB_HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
              "Content-Type": "application/json"}


def rpc(fn: str, body: dict = None):
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", headers=SB_HEADERS,
                   json=body or {}, timeout=120)
    r.raise_for_status()
    return r.json()


def sb_get(path: str, params: dict):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS,
                  params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def retrieval_gate(max_age_h: float = 48.0, drop_pct: float = 10.0):
    """Is retrieval healthy enough to retire memories tonight?

    Migration 068 declared the regression harness a hard prerequisite for the 065
    lifecycle work, but nothing ever enforced it: 211 rows were cold-tiered and
    migrations 073-075 shipped with no recorded run. This is that enforcement.

    Returns (ok, reason). Retirement is the one step here that is expensive to undo
    in bulk, so it is what gets gated — tier re-assignment is cheap and reversible
    and still runs. Fails CLOSED: no runs, a stale run, or an unreadable eval_runs
    table all block retirement, because "we cannot tell if recall regressed" is not
    a state in which to start dropping memories.
    """
    try:
        runs = sb_get("eval_runs", {
            "select": "tag,ndcg_at_10,created_at",
            "order": "created_at.desc", "limit": "8",
        })
    except Exception as e:
        return False, f"eval_runs unreadable ({e})"

    scored = [r for r in runs if r.get("ndcg_at_10") is not None]
    if not scored:
        return False, "no eval run has a recorded nDCG@10"

    newest = scored[0]
    from datetime import datetime, timezone
    ts = datetime.fromisoformat(newest["created_at"].replace("Z", "+00:00"))
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    if age_h > max_age_h:
        return False, (f"newest eval run '{newest['tag']}' is {age_h:.1f}h old "
                       f"(limit {max_age_h:.0f}h) — retrieval health unknown")

    prior = [r["ndcg_at_10"] for r in scored[1:]]
    if not prior:
        return True, f"nDCG@10 {newest['ndcg_at_10']:.3f} ({age_h:.1f}h old), no baseline yet"

    prior.sort()
    mid = len(prior) // 2
    median = prior[mid] if len(prior) % 2 else (prior[mid - 1] + prior[mid]) / 2.0
    if median > 0 and newest["ndcg_at_10"] < median * (1.0 - drop_pct / 100.0):
        return False, (f"nDCG@10 {newest['ndcg_at_10']:.3f} is >{drop_pct:.0f}% below "
                       f"trailing median {median:.3f} — retrieval regressed")
    return True, (f"nDCG@10 {newest['ndcg_at_10']:.3f} vs trailing median "
                  f"{median:.3f} ({age_h:.1f}h old)")


def send_discord(msg: str):
    try:
        httpx.post(f"{AGENT_BUS_URL}/message", json={"text": msg},
                   headers={"X-Agent-Secret": AGENT_BUS_SECRET}, timeout=15)
    except Exception as e:
        print(f"discord send failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true",
                    help="attempt a real retirement (still refused unless autoretire_enabled)")
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--notify", action="store_true", help="post the result to Discord")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SECRET_KEY missing", file=sys.stderr)
        return 2

    n_pairs = rpc("refresh_memory_duplicate_pairs")
    print(f"duplicate pairs cached: {n_pairs}")

    # Migration 114: recompute the A-MAC outcome-utility term from episode results
    # BEFORE tiers are assigned, so a memory that just helped complete a task is
    # scored on that evidence in the same pass rather than one night later.
    n_util = rpc("refresh_memory_outcome_utility")
    print(f"outcome utility refreshed: {n_util} rows changed")

    tiers = rpc("assign_memory_tiers")
    dist = {t["tier"]: t["n"] for t in tiers}
    print(f"tiers: {dist}")

    gate_ok, gate_reason = retrieval_gate()
    print(f"retrieval gate: {'PASS' if gate_ok else 'BLOCK'} — {gate_reason}")

    # A blocked gate downgrades this run to a dry run; it never aborts the pass,
    # because tier re-assignment above is exactly what we still want when recall
    # is shaky. Only the irreversible half is withheld.
    live = args.live and gate_ok
    batch = rpc("retire_cold_memories", {"p_limit": args.limit, "p_dry_run": not live})
    action = batch[0]["action"] if batch else "(none)"
    print(f"retirement batch ({len(batch)}): {action}")
    for b in batch:
        print(f"  - {b['name']}  (sv={b['standing_value']:.3f})")

    if args.notify:
        lines = [f"**Memory lifecycle pass** — tiers hot {dist.get('hot',0)} / "
                 f"warm {dist.get('warm',0)} / cold {dist.get('cold',0)}",
                 f"retrieval gate: {'PASS' if gate_ok else '**BLOCK**'} — {gate_reason}",
                 f"{len(batch)} in retirement batch — {action}"]
        if args.live and not gate_ok:
            lines.insert(1, "⚠️ --live was requested but retirement was held as a dry run.")
        if batch:
            lines += [f"• {b['name']}" for b in batch[:10]]
            if len(batch) > 10:
                lines.append(f"…and {len(batch)-10} more")
        send_discord("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
