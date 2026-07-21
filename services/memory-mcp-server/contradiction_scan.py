#!/usr/bin/env python3
"""
Daily memory contradiction / stale-propagation scan — REC-2 from the 2026-07-03
AI-memory research triage (Governed Shared Memory, arXiv 2606.24535).

Calls the scan_memory_contradictions() DB function (migration 052), which:
  1. Flags cross-agent 'contradiction' pairs — same topic (embedding sim in
     [0.88, 0.92); >= 0.92 is auto_detect_conflicts duplicate territory),
     different writer_agent, contents diverged > 7 days apart, top-25 per run.
     HIGH-CONFIDENCE pairs (sim >= 0.90, both trust_tier='high') also set
     conflict_flagged on the older memory so recall demotes it.
  2. Flags 'stale' propagation — active memories still linked to superseded or
     expired memories they haven't been updated since.

Results land in memory_conflicts (detected_by='contradiction-scan'); high-confidence
finds raise a sentinel notification so they surface on the dashboard notifications
page. Resolution stays manual/agent-driven via resolve_conflict() / list_conflicts.

Schedule: memory-contradiction-scan.timer (daily 03:30 UTC).
"""

import os
import sys
import json
import logging

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
SIM_FLOOR = float(os.environ.get("CONTRA_SIM_FLOOR", "0.88"))
SIM_CEILING = float(os.environ.get("CONTRA_SIM_CEILING", "0.92"))
HIGH_CONF_SIM = float(os.environ.get("CONTRA_HIGH_CONF_SIM", "0.90"))
MIN_AGE_GAP_DAYS = int(os.environ.get("CONTRA_MIN_AGE_GAP_DAYS", "7"))
MAX_NEW_PER_RUN = int(os.environ.get("CONTRA_MAX_NEW_PER_RUN", "25"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [contra] %(message)s")
log = logging.getLogger("contra")


def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def run_scan(client):
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/scan_memory_contradictions",
        json={
            "p_sim_floor": SIM_FLOOR,
            "p_sim_ceiling": SIM_CEILING,
            "p_high_conf_sim": HIGH_CONF_SIM,
            "p_min_age_gap_days": MIN_AGE_GAP_DAYS,
            "p_max_new": MAX_NEW_PER_RUN,
        },
        headers=sb_headers(),
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def run_temporal_supersession(client):
    """Mark superseded rows for unambiguous same-name/same-writer live duplicate
    sets (migration 056). Soft + reversible via supersede_memory(). Runs in the
    daily batch — async of the write-time near-duplicate gate."""
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/detect_temporal_supersession",
        json={"p_max_groups": int(os.environ.get("TEMPORAL_MAX_GROUPS", "50"))},
        headers=sb_headers(),
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def mark_consistency_checked(client):
    """Stamp consistency_checked_at on rows that came through the scan clean
    (migration 062). Deliberately NOT verified_at — the scan compares memories to
    each other, never to a live source, so it cannot vouch for a memory being
    still-true. Stamping verified_at here would reset the staleness clock on the
    whole corpus overnight and undo migration 060."""
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/mark_consistency_checked",
        json={},
        headers=sb_headers(),
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def notify_sentinel(client, summary):
    """Surface high-confidence finds on the dashboard notifications page."""
    high = summary.get("new_high_confidence", 0)
    body = (
        f"Contradiction scan found {high} new HIGH-CONFIDENCE cross-agent "
        f"contradiction(s) ({summary.get('new_contradictions', 0)} total new, "
        f"{summary.get('new_stale', 0)} stale-propagation, "
        f"{summary.get('open_conflicts_total', 0)} open conflicts overall). "
        f"{summary.get('newly_flagged_memories', 0)} memories conflict_flagged. "
        "Review via list_conflicts / resolve_conflict."
    )
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/sentinel_notifications",
        json={
            "source": "services",
            "severity": "warning",
            "status": "unread",
            "category": "memory-governance",
            "source_id": "contradiction-scan",
            "title": f"Memory conflicts: {high} high-confidence contradiction(s) detected",
            "body": body,
            "metadata": summary,
        },
        headers=sb_headers(),
        timeout=20,
    )
    r.raise_for_status()
    log.info("sentinel notification raised (%d high-confidence)", high)


def main():
    if not SUPABASE_KEY:
        log.error("SUPABASE_SECRET_KEY not set")
        return 1

    with httpx.Client() as client:
        summary = run_scan(client)
        log.info("scan summary: %s", json.dumps(summary))
        if summary.get("new_high_confidence", 0) > 0:
            notify_sentinel(client, summary)

        # Temporal supersession — mark superseded rows for unambiguous
        # same-name/same-writer live duplicate sets (async of the near-dup gate).
        try:
            ts = run_temporal_supersession(client)
            log.info("temporal supersession: %s", json.dumps(ts))
        except Exception as e:  # never let supersession fail the whole scan
            log.error("temporal supersession failed: %s", e)

        # Record which rows passed this scan clean (peer-consistency only).
        try:
            n = mark_consistency_checked(client)
            log.info("consistency_checked_at stamped on %s memories", n)
        except Exception as e:  # advisory signal — must not fail the scan
            log.error("mark_consistency_checked failed: %s", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
