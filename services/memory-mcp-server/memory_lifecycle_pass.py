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

    tiers = rpc("assign_memory_tiers")
    dist = {t["tier"]: t["n"] for t in tiers}
    print(f"tiers: {dist}")

    batch = rpc("retire_cold_memories", {"p_limit": args.limit, "p_dry_run": not args.live})
    action = batch[0]["action"] if batch else "(none)"
    print(f"retirement batch ({len(batch)}): {action}")
    for b in batch:
        print(f"  - {b['name']}  (sv={b['standing_value']:.3f})")

    if args.notify:
        lines = [f"**Memory lifecycle pass** — tiers hot {dist.get('hot',0)} / "
                 f"warm {dist.get('warm',0)} / cold {dist.get('cold',0)}",
                 f"{len(batch)} in retirement batch — {action}"]
        if batch:
            lines += [f"• {b['name']}" for b in batch[:10]]
            if len(batch) > 10:
                lines.append(f"…and {len(batch)-10} more")
        send_discord("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
