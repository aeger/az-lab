#!/usr/bin/env python3
"""
Injection retro-scan / rescan worker — REC 1 from the 2026-08-02 daily
self-improvement research (TIER 1).

WHY THIS EXISTS
    scanContent() in src/index.ts is reachable from three call sites and all
    three are WRITE paths (remember, save_skill, set_memory_block). The gate
    shipped in migration 076 on 2026-07-21. Measured 2026-08-02:

        total memories            955
        created before 076        785   (82%, never scanned even once)
        trust_tier=quarantined      0

    Those two numbers are the finding. quarantined=0 does not mean the corpus is
    clean; it is exactly what a corpus nobody ever checked looks like. OWASP
    ASI06 lists four interception points for memory poisoning — write-time
    admission (076), provenance binding (064), retrieval-time filtering
    (061/081), and post-hoc forensic detection. This script is the fourth.
    MPBench (arXiv 2607.14611) is the argument for why the fourth is not
    optional: attack and effect are temporally decoupled, so a row admitted
    under an older pattern set stays admitted forever.

WHAT IT DOES NOT DO
    It never sets trust_tier. Findings go to memory_scan_findings with
    status='pending' for human review. A false positive that quarantines a row
    drops it to recall weight 0.40 AND behind the 081 hard filter — the memory
    vanishes from every agent's view with no error raised anywhere. The current
    pattern set is KNOWN false-positive-heavy on this corpus: `authorized_keys`
    and `~/.ssh` match az-lab's own SSH bootstrap documentation. Those patterns
    carry severity 'low' in threat-patterns.json precisely so the review queue
    stays readable. Auto-quarantine is a deliberate non-feature.

PATTERN VERSIONING — the part that makes this more than a one-shot
    src/threat-patterns.json is the single source of truth, shared with the TS
    write-time scanner. Its `version` field is stamped onto every row this
    script clears (memories.scan_pattern_version). Bump the version after adding
    a pattern and the weekly timer re-scans the entire corpus against it, which
    is the property the forward-only design lacked.

USAGE
    python3 injection_scan.py                # scan rows behind the current version
    python3 injection_scan.py --all          # force full corpus rescan
    python3 injection_scan.py --dry-run      # report only, write nothing
    python3 injection_scan.py --limit 100    # cap rows (smoke test)

Schedule: memory-injection-rescan.timer (weekly, Mon 04:00 UTC — after the daily
contradiction scan at 03:30 so the two governance passes never interleave).
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")

SCRIPT_DIR = Path(__file__).resolve().parent
PATTERNS_PATH = Path(
    os.environ.get("THREAT_PATTERNS_PATH", SCRIPT_DIR / "src" / "threat-patterns.json")
)

PAGE_SIZE = 200
EXCERPT_RADIUS = 100
SCAN_FIELDS = ("name", "description", "content")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [injscan] %(message)s")
log = logging.getLogger("injscan")


# ── Pattern loading ─────────────────────────────────────────────────────────
def load_patterns():
    """Compile threat-patterns.json.

    The JSON is written in a regex dialect both JS RegExp and Python re accept.
    A pattern that fails to compile here is a HARD failure, not a skip: silently
    scanning with 13 of 14 patterns would stamp scan_pattern_version on rows that
    were never actually checked against the full set — the exact false-assurance
    this whole migration exists to remove.
    """
    spec = json.loads(PATTERNS_PATH.read_text(encoding="utf-8"))
    version = int(spec["version"])
    compiled = []
    for p in spec["patterns"]:
        flags = re.IGNORECASE if "i" in (p.get("flags") or "") else 0
        compiled.append((re.compile(p["re"], flags), p["id"], p.get("severity", "medium")))
    log.info("loaded %d patterns at version %d from %s", len(compiled), version, PATTERNS_PATH)
    return version, compiled


def scan_text(text, patterns):
    """Return every (threat_id, severity, match) in `text`.

    Unlike the TS scanContent(), which short-circuits on the first hit because it
    only needs a yes/no to block a write, this reports ALL matches — a reviewer
    triaging a finding wants to see everything the row tripped, not just the
    first pattern in list order.
    """
    hits = []
    for pattern, threat_id, severity in patterns:
        m = pattern.search(text)
        if m:
            hits.append((threat_id, severity, m))
    return hits


def excerpt_for(text, match):
    start = max(0, match.start() - EXCERPT_RADIUS)
    end = min(len(text), match.end() + EXCERPT_RADIUS)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{text[start:end]}{suffix}"


# ── Supabase ────────────────────────────────────────────────────────────────
# Transient-failure policy.
#
# 2026-08-11 19:48:55Z: the weekly run died on batch 2 of 5 with an unretried
# HTTP 500 from rpc/stamp_injection_scan and left the unit in `failed`. The
# Postgres log for that exact second reads "deadlock detected" — the 200-row
# `update memories ... where id = any(p_ids)` lost a deadlock against the
# concurrent writers that a host reboot sets off all at once (rpc/
# mark_consistency_checked took a 500 in the same window, four seconds earlier,
# and there were 4-5s ShareLock waits either side of it). Nothing about the
# request was wrong; it was simply unlucky about timing.
#
# Retrying is therefore the correct response, and it is safe: every write this
# script performs is idempotent. upsert_findings merges on the table's unique
# key and stamp_scanned sets two absolute bookkeeping columns, so replaying a
# batch converges to the same state. Not retrying is what turns one unlucky
# 40P01 into a silently skipped 800 rows of corpus coverage.
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
RETRY_ATTEMPTS = 5
RETRY_BASE_S = 1.5


def with_retry(label, fn):
    """Call fn(), retrying transient transport/5xx failures with exponential backoff.

    Deliberately does NOT retry 4xx (except 429): a malformed request or an RLS
    denial will fail identically forever, and burning four more attempts on it
    only delays a real error the operator needs to see.
    """
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            r = fn()
            if r.status_code in RETRY_STATUSES and attempt < RETRY_ATTEMPTS:
                raise httpx.HTTPStatusError(
                    f"retryable status {r.status_code}", request=r.request, response=r
                )
            r.raise_for_status()
            return r
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            retryable = status is None or status in RETRY_STATUSES
            if not retryable or attempt == RETRY_ATTEMPTS:
                raise
            delay = RETRY_BASE_S * (2 ** (attempt - 1))
            log.warning(
                "%s failed (%s) attempt %d/%d — retrying in %.1fs",
                label, status or type(e).__name__, attempt, RETRY_ATTEMPTS, delay,
            )
            time.sleep(delay)


def sb_headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def fetch_batch(client, version, scan_all, offset):
    """Page through candidate memories, oldest first.

    Ordering by created_at ASC is deliberate: the never-scanned population IS the
    old end of the corpus, so a run that gets cut short has still covered the
    rows that most needed it.
    """
    params = {
        "select": "id,name,description,content,created_at,trust_tier,writer_agent",
        "order": "created_at.asc",
    }
    if not scan_all:
        params["or"] = f"(scan_pattern_version.is.null,scan_pattern_version.lt.{version})"

    r = with_retry("fetch_batch", lambda: client.get(
        f"{SUPABASE_URL}/rest/v1/memories",
        params=params,
        headers=sb_headers({"Range-Unit": "items", "Range": f"{offset}-{offset + PAGE_SIZE - 1}"}),
        timeout=60,
    ))
    return r.json()


def upsert_findings(client, findings):
    """Idempotent on (memory_id, field, threat_id) — the table's unique key.

    merge-duplicates so a re-scan refreshes last_detected_at without resurrecting
    a finding a human already marked false_positive: status is NOT in the payload,
    so an existing row keeps whatever verdict the reviewer gave it.
    """
    if not findings:
        return 0
    r = with_retry("upsert_findings", lambda: client.post(
        f"{SUPABASE_URL}/rest/v1/memory_scan_findings",
        params={"on_conflict": "memory_id,field,threat_id"},
        json=findings,
        headers=sb_headers({"Prefer": "resolution=merge-duplicates,return=representation"}),
        timeout=60,
    ))
    return len(r.json())


def stamp_scanned(client, memory_ids, version, scanned_at):
    """Stamp via the stamp_injection_scan() RPC, never a raw PATCH.

    A direct PATCH on /memories would fire memories_updated_at and set
    updated_at = now() on every row it touched. Doing that across the corpus
    would flatten the timeline that contradiction detection (052), temporal
    supersession (056) and the stale-review queue (085/089/090) are derived from,
    with no way to recover the prior values. The RPC (migration 098) suppresses
    that bump for the two bookkeeping columns and can write nothing else.
    """
    if not memory_ids:
        return 0
    # Sorted, so every caller of this RPC takes row locks in the same order.
    # Postgres locks `where id = any(...)` in whatever order it reaches the
    # rows, and two concurrent updaters walking the same ids in different
    # orders is the textbook deadlock cycle — which is what killed the
    # 2026-08-11 run. Sorting does not make deadlock impossible (other writers
    # touch these rows by other paths, which is why with_retry wraps this too)
    # but it removes the one cycle this script can cause by itself.
    ordered = sorted(memory_ids)
    r = with_retry("stamp_scanned", lambda: client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/stamp_injection_scan",
        json={"p_ids": ordered, "p_version": version, "p_scanned_at": scanned_at},
        headers=sb_headers(),
        timeout=60,
    ))
    return r.json()


def coverage(client, version):
    r = with_retry("coverage", lambda: client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/injection_scan_coverage",
        json={"p_current_version": version},
        headers=sb_headers(),
        timeout=30,
    ))
    data = r.json()
    return data[0] if isinstance(data, list) and data else data


def notify_sentinel(client, summary):
    """Only HIGH-severity pending findings are worth waking anyone for.

    low/medium land in the queue and wait. Alerting on `~/.ssh` matches across a
    homelab corpus would train Jeff to ignore this notification inside a week.
    """
    high = summary["high_severity_matches"]
    r = with_retry("notify_sentinel", lambda: client.post(
        f"{SUPABASE_URL}/rest/v1/sentinel_notifications",
        json={
            "source": "services",
            "severity": "warning",
            "status": "unread",
            "category": "memory-governance",
            "source_id": "injection-rescan",
            "title": f"Memory injection scan: {high} HIGH-severity finding(s) need review",
            "body": (
                f"Scanned {summary['scanned']} memories at pattern version "
                f"{summary['pattern_version']}. {high} new HIGH-severity finding(s), "
                f"{summary['new_findings']} new finding(s) total, "
                f"{summary['pending_total']} pending overall. Nothing was quarantined — "
                "review public.memory_injection_review_queue and triage with "
                "resolve_scan_finding(finding_id, 'confirmed'|'false_positive'|'accepted_risk')."
            ),
            "metadata": summary,
        },
        headers=sb_headers(),
        timeout=20,
    ))
    log.info("sentinel notification raised (%d high-severity)", high)


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Retro/rescan memories for injection patterns")
    ap.add_argument("--all", action="store_true", help="rescan every row, ignoring scan_pattern_version")
    ap.add_argument("--dry-run", action="store_true", help="report only; write no findings and stamp nothing")
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = no cap)")
    args = ap.parse_args()

    if not SUPABASE_KEY:
        log.error("SUPABASE_SECRET_KEY not set")
        return 1

    version, patterns = load_patterns()
    now_iso = datetime.now(timezone.utc).isoformat()
    scanned = 0
    findings_written = 0
    by_threat = {}
    by_severity = {"high": 0, "medium": 0, "low": 0}
    flagged_memories = set()

    with httpx.Client() as client:
        before = coverage(client, version)
        log.info("coverage before: %s", json.dumps(before, default=str))

        # Paging discipline. With --all the filter is constant, so the window has
        # to advance. WITHOUT --all the filter is "behind the current version",
        # and stamping a batch removes exactly those rows from the result set —
        # advancing the offset there would skip a page per batch. So the drain
        # case re-reads from 0 every time. --dry-run never stamps, so it must
        # advance in both modes or it would loop on the same page forever.
        advance = args.all or args.dry_run
        offset = 0
        seen_ids = set()
        while True:
            rows = fetch_batch(client, version, args.all, offset)
            if not rows:
                break
            # Loop guard: if a page returns nothing we have not already processed,
            # the drain is not draining (write failure, permissions) — stop rather
            # than spin.
            fresh = [r for r in rows if r["id"] not in seen_ids]
            if not fresh:
                log.warning("page at offset %d returned no unseen rows — stopping to avoid a spin", offset)
                break
            rows = fresh
            seen_ids.update(r["id"] for r in rows)

            batch_findings = []
            batch_ids = []
            for row in rows:
                batch_ids.append(row["id"])
                for field in SCAN_FIELDS:
                    text = row.get(field) or ""
                    if not text:
                        continue
                    for threat_id, severity, match in scan_text(text, patterns):
                        by_threat[threat_id] = by_threat.get(threat_id, 0) + 1
                        by_severity[severity] = by_severity.get(severity, 0) + 1
                        flagged_memories.add(row["id"])
                        batch_findings.append({
                            "memory_id": row["id"],
                            "field": field,
                            "threat_id": threat_id,
                            "severity": severity,
                            "pattern_version": version,
                            "match_text": match.group(0)[:500],
                            "excerpt": excerpt_for(text, match),
                            "last_detected_at": now_iso,
                        })

            if args.dry_run:
                findings_written += len(batch_findings)
            else:
                findings_written += upsert_findings(client, batch_findings)
                # Stamp AFTER findings land. If the process dies between the two,
                # the row keeps its old version and gets re-scanned next run —
                # a duplicate scan is free, a silent coverage gap is not.
                stamp_scanned(client, batch_ids, version, now_iso)

            scanned += len(rows)
            log.info("scanned %d rows (offset %d), %d findings so far", scanned, offset, findings_written)

            if args.limit and scanned >= args.limit:
                log.info("--limit %d reached, stopping", args.limit)
                break
            if len(rows) < PAGE_SIZE:
                break
            if advance:
                offset += PAGE_SIZE

        after = coverage(client, version)
        summary = {
            "pattern_version": version,
            "scanned": scanned,
            "findings_written": findings_written,
            "high_severity_matches": by_severity.get("high", 0),
            "memories_with_findings": len(flagged_memories),
            "by_threat": by_threat,
            "by_severity": by_severity,
            "pending_total": after.get("pending_findings", 0),
            "never_scanned_remaining": after.get("never_scanned", 0),
            "behind_version_remaining": after.get("behind_version", 0),
            "dry_run": args.dry_run,
        }
        log.info("SUMMARY %s", json.dumps(summary, default=str))
        log.info("coverage after: %s", json.dumps(after, default=str))

        if not args.dry_run and summary["high_severity_matches"] > 0:
            try:
                notify_sentinel(client, summary)
            except Exception as e:  # a failed notification must not fail the scan
                log.error("sentinel notify failed: %s", e)

    return 0


if __name__ == "__main__":
    sys.exit(main())
