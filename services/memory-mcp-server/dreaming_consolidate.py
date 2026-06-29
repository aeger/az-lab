#!/usr/bin/env python3
"""
Nightly "dreaming" consolidation pass — REC-3 from 2026-05-15 research memo.

Scans memory_log for the last 24h, clusters entries by source+action+memory affinity,
and writes summary memories tagged 'dreaming' that link the source episodes.

Distinct from episodic_distill.py:
  - episodic_distill operates on episodic memories with access_count >= 3
  - dreaming_consolidate operates on memory_log (the audit stream) regardless of access
  - dreaming summaries are tagged 'dreaming' and easily filtered/reverted

Schedule: memory-dreaming-consolidate.timer (nightly at 04:30 UTC).
"""

import os
import sys
import json
import logging
import collections
from datetime import datetime, timezone, timedelta

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
WINDOW_HOURS = int(os.environ.get("DREAM_WINDOW_HOURS", "24"))
MIN_CLUSTER  = int(os.environ.get("DREAM_MIN_CLUSTER", "3"))
MAX_SUMMARIES = int(os.environ.get("DREAM_MAX_SUMMARIES", "8"))
DRY_RUN = os.environ.get("DREAM_DRY_RUN", "0") == "1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [dream] %(message)s")
log = logging.getLogger("dream")


def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def fetch_recent_log(client):
    since = (datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).isoformat()
    r = client.get(
        f"{SUPABASE_URL}/rest/v1/memory_log",
        params={
            "select": "id,memory_id,action,source,created_at,new_content",
            "created_at": f"gte.{since}",
            "order": "created_at.desc",
            "limit": "500",
        },
        headers=sb_headers(),
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def fetch_memory_meta(client, memory_ids):
    if not memory_ids:
        return {}
    ids = ",".join(f'"{i}"' for i in memory_ids)
    r = client.get(
        f"{SUPABASE_URL}/rest/v1/memories",
        params={
            "select": "id,name,type,tags,memory_class",
            "id": f"in.({ids})",
        },
        headers=sb_headers(),
        timeout=20,
    )
    r.raise_for_status()
    return {m["id"]: m for m in r.json()}


def cluster_log(log_rows, meta):
    """Cluster log rows by (source, primary tag/type). Returns list of (key, rows)."""
    buckets = collections.defaultdict(list)
    for row in log_rows:
        mid = row.get("memory_id")
        m = meta.get(mid) if mid else None
        tags = (m or {}).get("tags") or []
        primary_tag = tags[0] if tags else ((m or {}).get("type") or "uncategorised")
        key = (row.get("source") or "unknown", primary_tag)
        buckets[key].append({**row, "_meta": m})
    return [(k, v) for k, v in buckets.items() if len(v) >= MIN_CLUSTER]


def already_dreamed(client, key):
    src, tag = key
    name = f"Dreaming summary — {src} / {tag} / {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    r = client.get(
        f"{SUPABASE_URL}/rest/v1/memories",
        params={"select": "id", "name": f"eq.{name}", "limit": "1"},
        headers=sb_headers(),
        timeout=15,
    )
    r.raise_for_status()
    return (r.json() or []), name


def write_summary(client, key, rows, name):
    src, tag = key
    actions = collections.Counter(r["action"] for r in rows)
    sample = rows[0]
    sample_name = (sample.get("_meta") or {}).get("name") or "—"
    body_lines = [
        f"Source: {src}",
        f"Cluster tag/type: {tag}",
        f"Window: last {WINDOW_HOURS}h ({len(rows)} log entries)",
        f"Action mix: {dict(actions)}",
        f"Sample touch: {sample_name}",
        "",
        "Source log ids:",
    ]
    body_lines += [f"  - {r['id']} ({r['action']} @ {r['created_at']})" for r in rows[:20]]
    if len(rows) > 20:
        body_lines.append(f"  …+{len(rows)-20} more")

    payload = {
        "type": "project",
        "name": name,
        "description": f"Auto-generated dreaming consolidation for source={src} tag={tag}",
        "content": "\n".join(body_lines),
        "tags": ["dreaming", "auto", src, tag],
        "source": "dreaming_consolidate",
        "memory_class": "semantic",
        "confidence": 0.5,
    }
    if DRY_RUN:
        log.info("DRY: would write %s (%d rows)", name, len(rows))
        return None
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/memories",
        headers=sb_headers(),
        json=payload,
        timeout=20,
    )
    if r.status_code >= 300:
        log.warning("insert failed %s: %s", r.status_code, r.text[:200])
        return None
    return r.json()


def main():
    if not SUPABASE_KEY:
        log.error("SUPABASE_SECRET_KEY missing")
        sys.exit(2)

    with httpx.Client() as client:
        log_rows = fetch_recent_log(client)
        log.info("fetched %d log rows in last %dh", len(log_rows), WINDOW_HOURS)
        memory_ids = list({r["memory_id"] for r in log_rows if r.get("memory_id")})
        meta = fetch_memory_meta(client, memory_ids)
        clusters = sorted(cluster_log(log_rows, meta), key=lambda kv: -len(kv[1]))
        clusters = clusters[:MAX_SUMMARIES]
        log.info("eligible clusters: %d (min=%d, cap=%d)", len(clusters), MIN_CLUSTER, MAX_SUMMARIES)

        written = 0
        for key, rows in clusters:
            existing, name = already_dreamed(client, key)
            if existing:
                log.info("skip (already dreamed today): %s", name)
                continue
            res = write_summary(client, key, rows, name)
            if res:
                written += 1
                log.info("wrote %s", name)
        log.info("done. summaries_written=%d", written)


if __name__ == "__main__":
    main()
