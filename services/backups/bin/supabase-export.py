#!/usr/bin/env python3
"""Daily Supabase export — dumps every public table from the azlab-memory
project to versioned JSON files, plus the full public-schema DDL. Runs from a
systemd timer; output is pinned by ZFS snapshots on nvme-fast for immutability.

Reads SUPABASE_URL + SUPABASE_SECRET_KEY from environment (loaded by the
systemd unit) and writes to BACKUP_ROOT/YYYY-MM-DD/<table>.json.gz plus
BACKUP_ROOT/YYYY-MM-DD/schema.sql.gz.

SCHEMA LANE (added 2026-08-01, daily research REC 1.3)
    Until 2026-08-01 this script dumped ROWS ONLY. It enumerates tables via the
    PostgREST OpenAPI spec, which describes tables and views and nothing else —
    so it never touched function DDL. The live `hybrid_recall` ranker (6-lane RRF
    + A-MAC + trust weighting, ~22 KB of plpgsql) was therefore in NO backup and,
    because migrations 093a/093b/094 were applied direct-SQL, in no git object
    either. Restoring from this backup would have given every memory row back and
    no ranker to retrieve them with.

    There is no DATABASE_URL on this host — the unit holds the REST key only — so
    `pg_dump --schema-only` is not an option. Migration 095 adds
    public.export_schema_ddl(), a service_role-only RPC returning extensions,
    tables, constraints, indexes, views, functions, triggers and RLS policies as
    text. That is what this lane writes to schema.sql.gz.

    A schema dump failure is a FAILURE, not a warning: a rows-only backup is what
    this lane exists to stop shipping.
"""

import gzip
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib import error, parse, request

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SECRET_KEY"]
BACKUP_ROOT = Path(os.environ.get("BACKUP_ROOT", "/home/almty1/backups/supabase"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "5000"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "60"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("supabase-export")


def rest(
    path: str,
    params: dict | None = None,
    prefer: str | None = None,
    extra_headers: dict | None = None,
) -> tuple[list, dict]:
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    if params:
        url += "?" + parse.urlencode(params)
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    if extra_headers:
        headers.update(extra_headers)
    req = request.Request(url, headers=headers)
    with request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read())
        return body, dict(resp.headers)


def list_public_tables() -> list[str]:
    # PostgREST exposes the OpenAPI spec at the root; every public table or
    # view shows up as a definition key.
    req = request.Request(
        f"{SUPABASE_URL}/rest/v1/",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Accept": "application/openapi+json",
        },
    )
    with request.urlopen(req, timeout=60) as resp:
        spec = json.loads(resp.read())
    return sorted(spec.get("definitions", {}).keys())


def dump_table(table: str, out: Path) -> tuple[int, int]:
    # Use Range headers so PostgREST drives pagination — its server-side
    # max-rows cap silently shrinks an explicit ?limit=, but Range +
    # Content-Range tell us the true total and what we received.
    offset = 0
    rows_written = 0
    total: int | None = None
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        fh.write("[\n")
        first = True
        while True:
            end = offset + PAGE_SIZE - 1
            rows, hdrs = rest(
                table,
                params={"select": "*"},
                prefer="count=exact",
                extra_headers={"Range-Unit": "items", "Range": f"{offset}-{end}"},
            )
            cr = hdrs.get("Content-Range", "")
            # Format: "start-end/total" or "*/0" for empty
            if "/" in cr:
                try:
                    total = int(cr.rsplit("/", 1)[1])
                except ValueError:
                    total = None
            if not rows:
                break
            for row in rows:
                if not first:
                    fh.write(",\n")
                first = False
                fh.write(json.dumps(row, default=str, ensure_ascii=False))
                rows_written += 1
            offset += len(rows)
            if total is not None and rows_written >= total:
                break
            if len(rows) < PAGE_SIZE:
                # Server returned fewer than requested but we haven't hit
                # the declared total — keep paging using actual received.
                if total is None:
                    break
        fh.write("\n]\n")
    if total is not None and rows_written != total:
        log.warning("%s: dumped %d / %d rows", table, rows_written, total)
    return rows_written, out.stat().st_size


def dump_schema(out: Path) -> tuple[int, int]:
    """Write the full public-schema DDL to schema.sql.gz via the export_schema_ddl
    RPC (migration 095). Returns (chars, compressed_bytes).

    Sanity-checked before it is written: the DDL must contain hybrid_recall, the
    function this lane exists to protect. A truncated or empty response that still
    returned HTTP 200 would otherwise silently overwrite yesterday's good dump —
    which is the same class of failure as having no dump at all.
    """
    req = request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/export_schema_ddl",
        data=b"{}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=300) as resp:
        ddl = json.loads(resp.read())
    if not isinstance(ddl, str):
        raise RuntimeError(f"export_schema_ddl returned {type(ddl).__name__}, expected text")
    for required in ("CREATE OR REPLACE FUNCTION public.hybrid_recall", "===== TABLES ====="):
        if required not in ddl:
            raise RuntimeError(f"schema DDL missing {required!r} — refusing to write a partial dump")
    tmp = out.with_suffix(out.suffix + ".partial")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        fh.write(ddl)
    tmp.replace(out)
    return len(ddl), out.stat().st_size


def prune_old(root: Path, keep_days: int) -> int:
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for child in root.iterdir():
        if not child.is_dir():
            continue
        try:
            datetime.strptime(child.name, "%Y-%m-%d")
        except ValueError:
            continue
        if child.stat().st_mtime < cutoff:
            for f in child.rglob("*"):
                if f.is_file():
                    f.unlink()
            child.rmdir()
            removed += 1
    return removed


def main() -> int:
    started = time.time()
    today = date.today().isoformat()
    out_dir = BACKUP_ROOT / today
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        tables = list_public_tables()
    except error.HTTPError as e:
        log.error("failed to list tables: %s %s", e.code, e.read()[:300])
        return 2
    log.info("found %d tables", len(tables))

    manifest = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "project_url": SUPABASE_URL,
        "tables": {},
    }
    failures = 0
    for table in tables:
        out = out_dir / f"{table}.json.gz"
        try:
            rows, size = dump_table(table, out)
            manifest["tables"][table] = {"rows": rows, "bytes": size}
            log.info("dumped %s: %d rows, %d bytes", table, rows, size)
        except error.HTTPError as e:
            failures += 1
            manifest["tables"][table] = {"error": f"{e.code} {e.reason}"}
            log.error("failed %s: %s", table, e)
        except Exception as e:
            failures += 1
            manifest["tables"][table] = {"error": str(e)}
            log.exception("failed %s", table)

    # Schema lane — REC 1.3. Rows without schema is not a restorable backup.
    try:
        chars, size = dump_schema(out_dir / "schema.sql.gz")
        manifest["schema"] = {"chars": chars, "bytes": size}
        log.info("dumped schema DDL: %d chars, %d bytes", chars, size)
    except Exception as e:
        failures += 1
        manifest["schema"] = {"error": str(e)}
        log.exception("failed schema DDL dump — this backup is rows-only")

    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    manifest["elapsed_seconds"] = round(time.time() - started, 2)
    manifest["failures"] = failures
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    pruned = prune_old(BACKUP_ROOT, RETENTION_DAYS)
    log.info("pruned %d old dump directories (>%dd)", pruned, RETENTION_DAYS)
    log.info("done in %.1fs, failures=%d", time.time() - started, failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
