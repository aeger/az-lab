#!/usr/bin/env python3
"""
Weekly memory-health report -> Discord.

WHY (2026-07-23 research rec 3): the stale-review queue sat at 425 rows with a
four-month-old head and nobody noticed, because nothing reported on it. 2026
multi-agent production reporting puts ~79% of failures on coordination/context
problems rather than code defects, and az-lab already logs every signal needed to
see those coming. This is the cheapest item in the research set and the one that
surfaces the NEXT problem before it ages four months.

Emits: corpus size, tier distribution, never-accessed %, staleness queue depth and
age of head, open memory_conflicts, per-agent write counts, and the latest retrieval
regression numbers.

Run:  python3 memory_health_report.py [--dry-run]
"""
import argparse
import os
import sys
from datetime import datetime, timezone
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

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

def fetch_health() -> dict:
    """One call to memory_health_snapshot() (migration 069)."""
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/memory_health_snapshot",
                   headers=SB_HEADERS, json={}, timeout=45)
    r.raise_for_status()
    data = r.json()
    return data[0] if isinstance(data, list) else data


def pct(n, d):
    return f"{(100.0 * n / d):.0f}%" if d else "n/a"


def build_report(h: dict) -> str:
    active = h["active"] or 1
    L = []
    L.append("**Weekly memory health** — " + datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    L.append("")
    L.append(f"**Corpus** {h['total']} rows · {h['active']} active · {h['retired']} retired")
    L.append(f"**Tiers** hot {h['hot']} · warm {h['warm']} · cold {h['cold']} · pinned {h['pinned']}")
    L.append(f"**Never accessed** {h['never_accessed']} ({pct(h['never_accessed'], active)} of active)")

    head = h.get("queue_head_age")
    warn = " ⚠️" if head and head > 30 else ""
    L.append(f"**Stale queue** {h['queue_depth']} rows · head {head}d old{warn}")

    gate = "ON" if h.get("autoretire") else "OFF (dry-run only)"
    L.append(f"**Retirement** {h['retire_eligible']} eligible · "
             f"{h['retire_held_dup']} held for consolidation · auto-retire {gate}")
    L.append(f"**Near-duplicates** {h['dup_rows']} rows in >=0.92 clusters")
    L.append(f"**Open conflicts** {h['conflicts_open']}")

    ev = h.get("eval")
    if ev:
        L.append(f"**Retrieval eval** ({ev['tag']}) recall@5 {ev['recall_at_5']:.3f} · MRR {ev['mrr']:.3f}")

    # 2026-07-29 research rec 3c. `used` pools every evidence-of-use source
    # (recall bump, replayed episode, attributed task) — use_count alone reads
    # 4/33 while 9 skills demonstrably ran. The success rate counts LIVE outcomes
    # only, excluding the migration-104 backfill, so a backfill can never green
    # this line while the self-report loop is dead. `silent` is the number that
    # matters: skills the fleet selects but never reports an outcome for.
    sk = h.get("skills")
    if sk:
        live = (sk["live_success"] or 0) + (sk["live_fail"] or 0)
        rate = f"{(100.0 * sk['live_success'] / live):.0f}%" if live else "no live outcomes"
        silent = f" · ⚠️ {sk['silent']} used-but-silent" if sk["silent"] else ""
        L.append(f"**Skills** {sk['used']}/{sk['total']} used · "
                 f"{sk['reporting']} reporting · success {rate} ({live} live){silent}")

    writers = h.get("writers") or []
    if writers:
        w = " · ".join(f"{x['agent']} {x['n']}" for x in writers[:6])
        L.append(f"**Writes (7d)** {w}")
    return "\n".join(L)


def send_discord(msg: str) -> bool:
    try:
        r = httpx.post(f"{AGENT_BUS_URL}/message", json={"text": msg},
                       headers={"X-Agent-Secret": AGENT_BUS_SECRET}, timeout=15)
        return r.status_code < 300
    except Exception as e:
        print(f"discord send failed: {e}", file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print, do not post")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SECRET_KEY missing", file=sys.stderr)
        return 2

    report = build_report(fetch_health())
    print(report)
    if not args.dry_run and not send_discord(report):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
