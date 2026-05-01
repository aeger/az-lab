#!/usr/bin/env python3
"""archive_failed_runs.py — Phase 5.3 of unified scheduler.

Permanent CSV archive of every failed scheduler run, stored in R2 and
organized by month. The 7-day rolling window in scheduled_activity.runs[]
covers ops debugging; this archive is the long-term audit trail and
analysis substrate (open the monthly CSV in a spreadsheet).

Reads scheduled_activity_audit for entries since the last cursor where
the 'after' JSONB indicates a failure, appends one CSV row per failure
to the current month's CSV in R2, and rotates monthly.

Layout in R2 bucket az-lab-backups (same bucket the daily backups use):
  scheduler-failures/2026-05/failures.csv          ← live current-month CSV
  scheduler-failures/.state.json                    ← cursor + last_archived_month
  archive/scheduler-failures/2026-04.tar.gz        ← compressed past months
  archive/scheduler-failures/2026-03.tar.gz
  …

Runs hourly via systemd timer. Idempotent — cursor advances strictly forward.

CSV headers (clear/spreadsheet-friendly):
  timestamp_utc, scheduler_name, kind, status, duration_sec, result_summary,
  notes, source_ref_json, audit_action, audit_id
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import logging
import os
import sys
import tarfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"
ENV_FILE = Path.home() / "azlab/services/memory-mcp-server/.env"
R2_BUCKET = "az-lab-backups"
STATE_KEY = "scheduler-failures/.state.json"
LIVE_PREFIX = "scheduler-failures"
ARCHIVE_PREFIX = "archive/scheduler-failures"
CSV_HEADERS = [
    "timestamp_utc",
    "scheduler_name",
    "kind",
    "status",
    "duration_sec",
    "result_summary",
    "notes",
    "source_ref_json",
    "audit_action",
    "audit_id",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("archive-failed-runs")


# ── Env loading ──────────────────────────────────────────────────────────────


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    for k in ("SUPABASE_SECRET_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
              "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        if k in os.environ:
            env[k] = os.environ[k]
    return env


ENV = _load_env()
SUPABASE_KEY = ENV.get("SUPABASE_SECRET_KEY")
if not SUPABASE_KEY:
    log.error("SUPABASE_SECRET_KEY missing")
    sys.exit(2)

bucket = ENV.get("R2_BUCKET", R2_BUCKET)
account = ENV.get("R2_ACCOUNT_ID")
ak = ENV.get("R2_ACCESS_KEY_ID")
sk = ENV.get("R2_SECRET_ACCESS_KEY")
if not (account and ak and sk):
    log.error("R2 credentials missing in .env")
    sys.exit(2)

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
    aws_access_key_id=ak,
    aws_secret_access_key=sk,
    region_name="auto",
    config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
)


# ── Supabase REST ────────────────────────────────────────────────────────────


def supabase_get(path: str) -> Any:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


# ── State ────────────────────────────────────────────────────────────────────


def load_state() -> dict:
    try:
        obj = s3.get_object(Bucket=bucket, Key=STATE_KEY)
        data = json.loads(obj["Body"].read())
        return {
            "last_seen_audit_id": int(data.get("last_seen_audit_id", 0)),
            "current_month": data.get("current_month") or "",
        }
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            log.info("no prior state — starting fresh")
            return {"last_seen_audit_id": 0, "current_month": ""}
        raise


def save_state(state: dict) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=STATE_KEY,
        Body=json.dumps(state, indent=2).encode(),
        ContentType="application/json",
    )


# ── CSV append ───────────────────────────────────────────────────────────────


def fetch_current_csv(month: str) -> str:
    key = f"{LIVE_PREFIX}/{month}/failures.csv"
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return obj["Body"].read().decode("utf-8")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            # New month — write headers
            return ",".join(CSV_HEADERS) + "\n"
        raise


def write_current_csv(month: str, content: str) -> None:
    key = f"{LIVE_PREFIX}/{month}/failures.csv"
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=content.encode("utf-8"),
        ContentType="text/csv",
    )


# ── Monthly rotation ─────────────────────────────────────────────────────────


def rotate_month(month_to_archive: str) -> None:
    """Compress {LIVE_PREFIX}/{month}/failures.csv → archive/scheduler-failures/{month}.tar.gz, delete live."""
    live_key = f"{LIVE_PREFIX}/{month_to_archive}/failures.csv"
    try:
        obj = s3.get_object(Bucket=bucket, Key=live_key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            log.info(f"no live CSV for {month_to_archive} — nothing to archive")
            return
        raise
    csv_bytes = obj["Body"].read()
    if len(csv_bytes) < 200:  # just headers — skip
        log.info(f"{month_to_archive} live CSV is essentially empty ({len(csv_bytes)}B) — skipping archive")
        s3.delete_object(Bucket=bucket, Key=live_key)
        return

    # Build tar.gz: archive/scheduler-failures/YYYY-MM.tar.gz containing failures.csv
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=6) as tf:
        info = tarfile.TarInfo(name=f"{month_to_archive}/failures.csv")
        info.size = len(csv_bytes)
        info.mtime = int(datetime.now(timezone.utc).timestamp())
        tf.addfile(info, io.BytesIO(csv_bytes))

    archive_key = f"{ARCHIVE_PREFIX}/{month_to_archive}.tar.gz"
    s3.put_object(
        Bucket=bucket,
        Key=archive_key,
        Body=buf.getvalue(),
        ContentType="application/gzip",
    )
    log.info(f"archived {month_to_archive}: {len(csv_bytes)}B CSV → {len(buf.getvalue())}B tar.gz @ {archive_key}")

    # Delete the live CSV (the new month starts fresh on next append)
    s3.delete_object(Bucket=bucket, Key=live_key)


# ── Main ─────────────────────────────────────────────────────────────────────


def is_failure(entry: dict) -> bool:
    """Treat as failure if action is *_failed OR after.status='failure'."""
    if entry.get("action", "").endswith("_failed"):
        return True
    after = entry.get("after") or {}
    if isinstance(after, str):
        try:
            after = json.loads(after)
        except Exception:
            after = {}
    if isinstance(after, dict) and str(after.get("status", "")).lower() == "failure":
        return True
    return False


def main() -> int:
    started = datetime.now(timezone.utc)
    state = load_state()
    cursor = state["last_seen_audit_id"]
    last_month = state["current_month"]
    this_month = started.strftime("%Y-%m")

    log.info(f"start cursor={cursor} last_month={last_month or '(new)'} this_month={this_month}")

    # Monthly rotation BEFORE we append new rows: if month changed, tar.gz
    # the previous month and let the new month start fresh.
    if last_month and last_month != this_month:
        rotate_month(last_month)

    # Pull new audit entries since cursor. Filter to failures client-side
    # (the action set is small enough that 1000 rows is well under the
    # PostgREST default page).
    entries = supabase_get(
        f"scheduled_activity_audit?id=gt.{cursor}"
        "&order=id.asc&limit=1000"
        "&select=id,scheduled_activity_id,scheduled_activity_name,action,after,notes,created_at"
    )
    failures = [e for e in entries if is_failure(e)]
    log.info(f"audit since cursor: {len(entries)} entries, {len(failures)} failures")

    if failures:
        # Fetch each row's kind + source_ref by joining via name (cheap
        # since # of distinct names is tiny).
        names = sorted({e["scheduled_activity_name"] for e in failures if e.get("scheduled_activity_name")})
        meta_by_name: dict[str, dict] = {}
        if names:
            in_list = "(" + ",".join(f'"{n}"' for n in names) + ")"
            meta_rows = supabase_get(f"scheduled_activity?name=in.{in_list}&select=name,kind,source_ref")
            meta_by_name = {r["name"]: r for r in meta_rows}

        live = fetch_current_csv(this_month)
        out = io.StringIO()
        out.write(live)
        if not live.endswith("\n"):
            out.write("\n")
        writer = csv.writer(out, lineterminator="\n")
        for e in failures:
            after = e.get("after") or {}
            if isinstance(after, str):
                try: after = json.loads(after)
                except Exception: after = {}
            meta = meta_by_name.get(e.get("scheduled_activity_name", ""), {})
            writer.writerow([
                e.get("created_at", ""),
                e.get("scheduled_activity_name", ""),
                meta.get("kind", "?"),
                str(after.get("status", "")) or "failure",
                str(after.get("duration_sec", "")) if after.get("duration_sec") is not None else "",
                str(after.get("result_summary", "") or after.get("output", "") or after.get("error", ""))[:500],
                e.get("notes", "") or "",
                json.dumps(meta.get("source_ref", {}), separators=(",", ":")),
                e.get("action", ""),
                e.get("id", ""),
            ])
        write_current_csv(this_month, out.getvalue())
        log.info(f"appended {len(failures)} failure rows to {LIVE_PREFIX}/{this_month}/failures.csv")
        cursor = max(int(e["id"]) for e in entries)
    elif entries:
        cursor = max(int(e["id"]) for e in entries)

    save_state({"last_seen_audit_id": cursor, "current_month": this_month})
    log.info(f"done — cursor={cursor} current_month={this_month}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
