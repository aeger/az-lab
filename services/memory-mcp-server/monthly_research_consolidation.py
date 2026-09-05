#!/usr/bin/env python3
"""
Monthly consolidation of the daily-research series -> one Research Digest per month.

WHY (2026-07-29 research REC 2): `Daily Self-Improvement Research - *` was the
corpus's largest single polluter — 120 rows / 624,815 chars, 13% of rows and ~27%
of all content, with retired_at set on ZERO rows. Digests for 2026-03..06 were
written by hand on 2026-07-30 and then nothing ran again: July finished on the
31st and was still sitting unconsolidated on 2026-08-11, twelve days later,
because the consolidation was a thing someone remembered to do rather than a
thing that happened. Same failure shape as the eval harness before it went on a
timer (2026-07-25 research: "a regression harness that runs only when someone
remembers it cannot catch a regression").

WHAT THIS DOES **NOT** DO: write the digest. The digest is prose — a month's
findings, what shipped off them, what was dropped and why — and 2026 evidence is
explicit that fine-grained automated fact-extraction degrades multi-hop reasoning
(REC 2c: do NOT let extracted_facts replace digest prose). A regex summarizer
would produce exactly the lossy artifact the recommendation warns against. So
this job DETECTS the debt and QUEUES an agent to do the reading, which is the
same division of labour the rest of the fleet uses.

Conservative by construction:
  - monthly, never weekly (REC 2c)
  - only COMPLETE calendar months — the current month is never touched
  - a month is skipped once its digest exists AND its dailies are superseded
  - queues one task per unconsolidated month, idempotent via recurring_key

Run:  python3 monthly_research_consolidation.py [--dry-run]
"""
import argparse
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import httpx

ENV_FILE = Path(__file__).resolve().parent / ".env"

SERIES_PREFIX = "Daily Self-Improvement Research - "
DIGEST_PREFIX = "Research Digest - "

# Months before this were consolidated by hand and their raw rows are already
# retired; nothing to detect and no reason to re-scan them every run.
FIRST_MANAGED_MONTH = "2026-03"


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

SB = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def _check(r: httpx.Response, what: str):
    """raise_for_status() alone throws away the response body, which is the only
    place PostgREST puts the constraint name — a CHECK violation surfaced as a
    bare "Client error '400 Bad Request'" with no hint which column was wrong.
    """
    if r.is_success:
        return
    raise RuntimeError(f"{what} failed: HTTP {r.status_code} {r.text[:1000]}")


def sb_get(table: str, params: dict) -> list:
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{table}", params=params, headers=SB, timeout=45)
    _check(r, f"GET {table}")
    return r.json()


def sb_post(table: str, rows: list) -> list:
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/{table}", json=rows,
                   headers={**SB, "Prefer": "return=representation"}, timeout=45)
    _check(r, f"POST {table}")
    return r.json()


def month_key(name: str) -> str:
    """'Daily Self-Improvement Research - 2026-07-15 Triage' -> '2026-07'."""
    return name[len(SERIES_PREFIX):][:7]


def complete_months_today(today: date) -> set:
    """Every month strictly before the current one is complete."""
    return {f"{today.year:04d}-{today.month:02d}"}


def find_unconsolidated() -> list:
    """Months with live (non-superseded) dailies that are already complete.

    A month counts as done when every daily in it carries superseded_by. The
    digest existing is NOT sufficient on its own — 2026-07 briefly had neither,
    and a half-finished month must still show up as work.
    """
    dailies = sb_get("memories", {
        "select": "name,superseded_by,content",
        "name": f"like.{SERIES_PREFIX}%",
        "order": "name",
    })
    digests = {m["name"][len(DIGEST_PREFIX):]
               for m in sb_get("memories", {"select": "name", "name": f"like.{DIGEST_PREFIX}%"})}

    current = complete_months_today(datetime.now(timezone.utc).date())
    buckets: dict = {}
    for d in dailies:
        mk = month_key(d["name"])
        if mk < FIRST_MANAGED_MONTH or mk in current:
            continue  # never touch the in-progress month
        b = buckets.setdefault(mk, {"month": mk, "rows": 0, "live": 0, "chars": 0})
        b["rows"] += 1
        b["chars"] += len(d.get("content") or "")
        if not d.get("superseded_by"):
            b["live"] += 1

    return [b | {"has_digest": b["month"] in digests}
            for b in sorted(buckets.values(), key=lambda x: x["month"])
            if b["live"] > 0]


def queue_task(m: dict, dry: bool) -> str:
    key = f"research-digest-{m['month']}"
    existing = sb_get("task_queue", {
        "select": "id,status", "recurring_key": f"eq.{key}",
        "status": "in.(pending,ready,claimed,in_progress,blocked,pending_jeff_action)",
    })
    if existing:
        return f"already queued ({existing[0]['status']})"
    if dry:
        return "would queue"

    body = (
        f"Consolidate the {m['rows']} `{SERIES_PREFIX}{m['month']}-*` entries "
        f"({m['chars']:,} chars, {m['live']} not yet superseded) into a single "
        f"`{DIGEST_PREFIX}{m['month']}` memory, then retire the raw dailies.\n\n"
        "Method (2026-07-29 research REC 2 — follow it, it is deliberately conservative):\n"
        "1. READ the month's entries. This is an LLM pass over the prose, not an extraction "
        "job — fine-grained fact extraction degrades multi-hop reasoning, so the digest must "
        "stay prose. Do NOT let extracted_facts stand in for it.\n"
        "2. Write ONE `" + DIGEST_PREFIX + m["month"] + "` memory structured as: what was "
        "recommended, what actually shipped off it (cite the migration/commit), and what was "
        "dropped and why. Include reading guidance. Match the voice of the existing digests — "
        "`recall \"Research Digest\"` for the 2026-03..07 set.\n"
        "3. Set is_point_in_time=true, type=project, tags include research-digest + "
        "monthly-consolidation.\n"
        "4. Link every source to the digest with `supersede_memory(old_id, digest_id, reason, "
        "'evidence_weighted_merge')` — NOT a direct memory_links insert; migration 105 guards "
        "that edge and will reject it.\n"
        "5. Set retired_at on the superseded rows.\n\n"
        "Verify before starting: some of the month may already be done."
    )

    sb_post("task_queue", [{
        "title": f"Consolidate {m['month']} daily research into a monthly digest",
        "description": body,
        # priority must be 0..3 (task_queue_priority_check) and source must be
        # one of the seven allowed values (task_queue_source_check) — this row
        # previously carried priority=5 / source="monthly-research-consolidation"
        # and would have been rejected on the first month that had real work.
        # Provenance lives in context.source_job instead of source.
        "priority": 3,
        "status": "ready",
        "source": "system",
        "target": "claude-code",
        "tags": ["memory", "consolidation", "research-digest"],
        "recurring_key": key,
        "context": {
            "month": m["month"], "rows": m["rows"], "live_rows": m["live"],
            "chars": m["chars"], "digest_exists": m["has_digest"],
            "rec": "2026-07-29 research REC 2",
            "source_job": "monthly-research-consolidation",
        },
    }])
    return "queued"


def notify(msg: str):
    try:
        httpx.post(f"{AGENT_BUS_URL}/message", json={"text": msg},
                   headers={"X-Agent-Secret": AGENT_BUS_SECRET}, timeout=15)
    except Exception as e:
        print(f"discord notify failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report, do not queue or notify")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SECRET_KEY missing", file=sys.stderr)
        return 2

    pending = find_unconsolidated()
    if not pending:
        print("all complete months consolidated — nothing to do")
        return 0

    lines, failures = [], []
    for m in pending:
        try:
            outcome = queue_task(m, args.dry_run)
        except Exception as e:  # a queue failure must be loud, not a log-file traceback
            outcome = f"QUEUE FAILED: {e}"
            failures.append(m["month"])
        line = (f"{m['month']}: {m['live']}/{m['rows']} rows live, {m['chars']:,} chars, "
                f"digest={'yes' if m['has_digest'] else 'no'} -> {outcome}")
        print(line, file=sys.stderr if failures and failures[-1] == m["month"] else sys.stdout)
        lines.append(line)

    if not args.dry_run and (failures or any(l.endswith("-> queued") for l in lines)):
        head = ("**Monthly research consolidation** — FAILED to queue "
                f"{len(failures)} month(s):" if failures
                else "**Monthly research consolidation** — unconsolidated month(s) detected:")
        notify(head + "\n" + "\n".join(f"- {l}" for l in lines))
    if failures:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
