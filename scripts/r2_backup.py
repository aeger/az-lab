#!/usr/bin/env python3
"""r2_backup.py — az-lab R2 backup script

Backs up critical data to Cloudflare R2 (az-lab-backups bucket).
Run nightly at 02:00 UTC via claude-r2-backup.timer.

Backups:
  - Supabase tables (JSON export)          → supabase/YYYY-MM-DD.json        (daily, 7d retention)
  - Traefik dynamic configs + acme.json    → traefik/YYYY-MM-DD/*.tar.gz     (daily, 7d retention)
  - AdGuard Home rewrites + status         → adguard/YYYY-MM-DD/*.json       (daily, 7d retention)
  - LLDAP SQLite DB + config               → lldap/YYYY-MM-DD/*.tar.gz       (daily, 7d retention)
  - Claude harness config                  → claude-config/YYYY-MM-DD/*.tar.gz  (daily, 14d retention)
  - SSH key fingerprint inventory          → ssh-inventory/YYYY-MM-DD.txt    (weekly on Sunday)
  - Full az-lab repo + dashboard tarball   → weekly-full/YYYY-MM-DD.tar.gz   (weekly on Sunday, 8w retention)

Status: each task writes a row to the Supabase backup_status table; the
dashboard reads backup_status_latest to surface health. On failure (or stale
detection), a Discord alert fires and a HIGH-priority audit task is queued.

Credentials: loaded from ~/azlab/services/memory-mcp-server/.env (R2_* vars)
"""

import datetime
import io
import json
import logging
import os
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("r2-backup")

# ── Config ────────────────────────────────────────────────────────────────────
ENV_FILE = Path.home() / "azlab/services/memory-mcp-server/.env"
BACKUP_BUCKET = "az-lab-backups"
ADGUARD_URL = "http://192.168.99.2"
TODAY = datetime.date.today().isoformat()
WEEKDAY = datetime.date.today().weekday()  # 0=Monday, 6=Sunday


# ── Load .env ─────────────────────────────────────────────────────────────────
def load_env(path: Path) -> dict:
    env: dict = {}
    if not path.exists():
        log.warning(f"Env file not found: {path}")
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip()
    return env


env = load_env(ENV_FILE)

R2_ACCOUNT_ID = env.get("R2_ACCOUNT_ID") or os.environ.get("CF_R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = env.get("R2_ACCESS_KEY_ID") or os.environ.get("CF_R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = env.get("R2_SECRET_ACCESS_KEY") or os.environ.get("CF_R2_SECRET_ACCESS_KEY", "")
SUPABASE_URL = env.get("SUPABASE_URL", "")
SUPABASE_KEY = env.get("SUPABASE_SECRET_KEY", "")
# Use the secret/service key for inserts so RLS doesn't block status + audit task writes.
# This script runs server-side (systemd user unit) — service role is appropriate.
SUPABASE_WRITE_KEY = SUPABASE_KEY or env.get("SUPABASE_WRITE_KEY", "")
ADGUARD_USERNAME = env.get("ADGUARD_USERNAME", "") or os.environ.get("ADGUARD_USERNAME", "")
ADGUARD_PASSWORD = env.get("ADGUARD_PASSWORD", "") or os.environ.get("ADGUARD_PASSWORD", "")

DISCORD_CHANNEL = "1012721652049657896"
AGENT_BUS_URL = "http://localhost:8765"
AGENT_BUS_SECRET = env.get("AGENT_BUS_SECRET", "") or os.environ.get("AGENT_BUS_SECRET", "azlab-agent-bus")
HOST = os.environ.get("HOSTNAME") or os.uname().nodename

if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
    log.error("Missing R2 credentials — check ~/azlab/services/memory-mcp-server/.env")
    sys.exit(1)

# ── R2 / S3 client ────────────────────────────────────────────────────────────
try:
    import boto3
    from botocore.config import Config as BotoConfig

    s3 = boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=BotoConfig(signature_version="s3v4"),
    )
except ImportError:
    log.error("boto3 not installed — run: pip3 install boto3")
    sys.exit(1)


# ── Helpers ───────────────────────────────────────────────────────────────────
def upload(key: str, data: bytes, content_type: str = "application/octet-stream") -> bool:
    try:
        s3.put_object(Bucket=BACKUP_BUCKET, Key=key, Body=data, ContentType=content_type)
        log.info(f"  uploaded: {key} ({len(data):,} bytes)")
        return True
    except Exception as e:
        log.error(f"  upload failed {key}: {e}")
        return False


# ── Status / notification ─────────────────────────────────────────────────────
def _supabase_post(path: str, payload: dict, prefer: str = "return=minimal") -> bool:
    if not SUPABASE_URL or not SUPABASE_WRITE_KEY:
        return False
    try:
        body = json.dumps(payload, default=str).encode()
        req = urllib.request.Request(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
            data=body,
            headers={
                "Content-Type": "application/json",
                "apikey": SUPABASE_WRITE_KEY,
                "Authorization": f"Bearer {SUPABASE_WRITE_KEY}",
                "Prefer": prefer,
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read()
        return True
    except Exception as e:
        log.warning(f"  Supabase POST {path} failed: {e}")
        return False


def record_status(
    name: str,
    prefix: str,
    cadence: str,
    expected_interval_hours: int,
    status: str,
    started_at: datetime.datetime,
    bytes_: int | None = None,
    object_key: str | None = None,
    error: str | None = None,
    metadata: dict | None = None,
) -> None:
    completed_at = datetime.datetime.now(datetime.timezone.utc)
    duration_ms = int((completed_at - started_at).total_seconds() * 1000)
    payload = {
        "name": name,
        "prefix": prefix,
        "cadence": cadence,
        "expected_interval_hours": expected_interval_hours,
        "status": status,
        "started_at": started_at.isoformat(),
        "completed_at": completed_at.isoformat(),
        "duration_ms": duration_ms,
        "bytes": bytes_,
        "object_key": object_key,
        "error": (error[:1000] if error else None),
        "host": HOST,
        "metadata": metadata or {},
    }
    _supabase_post("backup_status", payload)


def send_discord(msg: str) -> None:
    try:
        payload = json.dumps({"text": msg}).encode()
        req = urllib.request.Request(
            f"{AGENT_BUS_URL}/message",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Agent-Secret": AGENT_BUS_SECRET,
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log.warning(f"  Discord send failed: {e}")


def queue_audit_task(name: str, reason: str, context: dict) -> None:
    """Insert a HIGH-priority audit task on backup failure."""
    payload = {
        "title": f"Audit backup failure: {name}",
        "description": (
            f"Backup task '{name}' is unhealthy: {reason}\n\n"
            f"Investigate the r2_backup.py task, run it by hand to confirm, "
            f"and restore weekly cadence. See journalctl --user -u claude-r2-backup.service."
        ),
        "context": context,
        "priority": 1,                 # 0=urgent, 1=high, 2=normal, 3=low
        "status": "ready",             # constrained allowlist; "ready" = available for pickup
        "source": "system",            # constrained allowlist; "system" is the catch-all
        "target": "wren",
        "tags": ["backup", "audit", "auto-created"],
    }
    _supabase_post("task_queue", payload)


def notify_failure(name: str, reason: str, context: dict | None = None) -> None:
    ctx = context or {}
    msg = (
        f"⚠️ **Backup failure — {name}**\n"
        f"{reason}\n"
        f"Auto-queued audit task for Wren. Bucket: `{BACKUP_BUCKET}/{ctx.get('prefix','?')}`"
    )
    send_discord(msg)
    queue_audit_task(name, reason, {"prefix": ctx.get("prefix"), "host": HOST, **ctx})


def prune(prefix: str, keep_days: int) -> None:
    """Delete backup objects under prefix that are older than keep_days."""
    try:
        resp = s3.list_objects_v2(Bucket=BACKUP_BUCKET, Prefix=prefix)
        if "Contents" not in resp:
            return
        cutoff = datetime.date.today() - datetime.timedelta(days=keep_days)
        victims = []
        for obj in resp["Contents"]:
            date_part = obj["Key"].replace(prefix, "").lstrip("/").split("/")[0][:10]
            try:
                if datetime.date.fromisoformat(date_part) < cutoff:
                    victims.append({"Key": obj["Key"]})
            except ValueError:
                pass
        if victims:
            s3.delete_objects(Bucket=BACKUP_BUCKET, Delete={"Objects": victims})
            log.info(f"  pruned {len(victims)} old object(s) under {prefix}")
    except Exception as e:
        log.warning(f"  prune failed for {prefix}: {e}")


def make_tarball(paths: list) -> bytes:
    """Tar + gzip a list of Path objects into an in-memory buffer."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for p in paths:
            p = Path(p)
            if p.exists():
                tf.add(str(p), arcname=p.name)
            else:
                log.warning(f"  not found, skipping: {p}")
    return buf.getvalue()


def http_get(url: str, timeout: int = 10, basic_auth: tuple[str, str] | None = None) -> bytes | None:
    try:
        req = urllib.request.Request(url)
        if basic_auth and basic_auth[0]:
            import base64
            token = base64.b64encode(f"{basic_auth[0]}:{basic_auth[1]}".encode()).decode()
            req.add_header("Authorization", f"Basic {token}")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as e:
        log.warning(f"  GET {url} failed: {e}")
        return None


# ── 1. Supabase export ────────────────────────────────────────────────────────
SUPABASE_TABLES = [
    "memories",
    "memory_links",
    "memory_files",
    "memory_conflicts",
    "skills",
    "task_queue",
]


def backup_supabase() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.warning("Supabase credentials missing — skipping")
        record_status("supabase", "supabase/", "daily", 30, "skipped", started,
                      error="credentials missing")
        return

    export: dict = {}
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }

    for table in SUPABASE_TABLES:
        url = f"{SUPABASE_URL}/rest/v1/{table}?select=*&limit=50000"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                rows = json.loads(resp.read().decode())
                export[table] = rows
                log.info(f"  {table}: {len(rows)} rows")
        except Exception as e:
            log.warning(f"  {table}: failed — {e}")
            export[table] = []

    payload = json.dumps(export, default=str, indent=2).encode()
    key = f"supabase/{TODAY}.json"
    if upload(key, payload, "application/json"):
        prune("supabase/", keep_days=7)
        record_status("supabase", "supabase/", "daily", 30, "success", started,
                      bytes_=len(payload), object_key=key,
                      metadata={"tables": {t: len(export.get(t, [])) for t in SUPABASE_TABLES}})
    else:
        record_status("supabase", "supabase/", "daily", 30, "failed", started,
                      bytes_=len(payload), object_key=key, error="upload failed")
        raise RuntimeError("supabase upload failed")


# ── 2. Traefik config + acme.json ─────────────────────────────────────────────
def backup_traefik() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    base = Path.home() / "azlab/infrastructure/traefik"
    dynamic_dir = base / "dynamic"
    acme_candidates = [base / "data" / "acme.json", base / "acme.json"]
    acme = next((p for p in acme_candidates if p.exists()), None)

    paths = sorted(dynamic_dir.glob("*.yml")) if dynamic_dir.exists() else []
    if acme:
        paths.append(acme)

    if not paths:
        log.warning("No Traefik files found — skipping")
        record_status("traefik", "traefik/", "daily", 30, "skipped", started,
                      error="no files found")
        return

    data = make_tarball(paths)
    key = f"traefik/{TODAY}/traefik-configs.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("traefik/", keep_days=7)
        record_status("traefik", "traefik/", "daily", 30, "success", started,
                      bytes_=len(data), object_key=key,
                      metadata={"files": [p.name for p in paths]})
    else:
        record_status("traefik", "traefik/", "daily", 30, "failed", started,
                      bytes_=len(data), object_key=key, error="upload failed")
        raise RuntimeError("traefik upload failed")


# ── 3. AdGuard config + rewrites ──────────────────────────────────────────────
def backup_adguard() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    auth = (ADGUARD_USERNAME, ADGUARD_PASSWORD) if ADGUARD_USERNAME else None

    # Retry up to 3 times for transient network issues at startup
    raw = None
    for attempt in range(1, 4):
        raw = http_get(f"{ADGUARD_URL}/control/rewrite/list", basic_auth=auth)
        if raw is not None:
            break
        if attempt < 3:
            log.warning(f"AdGuard attempt {attempt} failed, retrying in 5s...")
            time.sleep(5)

    if raw is None:
        log.warning(f"AdGuard unreachable at {ADGUARD_URL} after 3 attempts — skipping")
        record_status("adguard", "adguard/", "daily", 30, "skipped", started,
                      error="AdGuard unreachable after retries")
        return

    try:
        rewrites = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("AdGuard rewrite response not valid JSON — skipping")
        record_status("adguard", "adguard/", "daily", 30, "skipped", started,
                      error="rewrites response not JSON")
        return

    status: dict = {}
    raw_status = http_get(f"{ADGUARD_URL}/control/status", basic_auth=auth)
    if raw_status:
        try:
            status = json.loads(raw_status)
        except json.JSONDecodeError:
            pass

    export = {"rewrites": rewrites, "status": status, "exported_at": TODAY}
    payload = json.dumps(export, default=str, indent=2).encode()
    key = f"adguard/{TODAY}/adguard-config.json"
    if upload(key, payload, "application/json"):
        prune("adguard/", keep_days=7)
        record_status("adguard", "adguard/", "daily", 30, "success", started,
                      bytes_=len(payload), object_key=key)
    else:
        record_status("adguard", "adguard/", "daily", 30, "failed", started,
                      bytes_=len(payload), object_key=key, error="upload failed")
        raise RuntimeError("adguard upload failed")


# ── 4. LLDAP data ─────────────────────────────────────────────────────────────
def backup_lldap() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    lldap_data = Path.home() / "azlab/services/lldap/data"
    paths = [lldap_data / "users.db", lldap_data / "lldap_config.toml"]
    existing = [p for p in paths if p.exists()]

    if not existing:
        log.warning("No LLDAP data files found — skipping")
        record_status("lldap", "lldap/", "daily", 30, "skipped", started,
                      error="no data files found")
        return

    data = make_tarball(existing)
    key = f"lldap/{TODAY}/lldap-data.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("lldap/", keep_days=7)
        record_status("lldap", "lldap/", "daily", 30, "success", started,
                      bytes_=len(data), object_key=key,
                      metadata={"files": [p.name for p in existing]})
    else:
        record_status("lldap", "lldap/", "daily", 30, "failed", started,
                      bytes_=len(data), object_key=key, error="upload failed")
        raise RuntimeError("lldap upload failed")


# ── 5. SSH key inventory (weekly — Sundays only) ──────────────────────────────
def backup_ssh_inventory() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    if WEEKDAY != 6:
        log.info("  skipping (not Sunday)")
        record_status("ssh-inventory", "ssh-inventory/", "weekly", 192, "skipped",
                      started, error="not Sunday")
        return

    ssh_dir = Path.home() / ".ssh"
    if not ssh_dir.exists():
        log.warning("~/.ssh not found — skipping")
        record_status("ssh-inventory", "ssh-inventory/", "weekly", 192, "skipped",
                      started, error="~/.ssh not found")
        return

    lines = [f"SSH Key Inventory — {TODAY}", "=" * 50, ""]

    for pub in sorted(ssh_dir.glob("*.pub")):
        try:
            result = subprocess.run(
                ["ssh-keygen", "-l", "-f", str(pub)],
                capture_output=True, text=True, timeout=10,
            )
            lines.append(f"  {pub.name}")
            if result.returncode == 0:
                lines.append(f"    {result.stdout.strip()}")
            else:
                lines.append(f"    (fingerprint error)")
        except Exception as e:
            lines.append(f"  {pub.name}: error — {e}")

    lines += ["", "All ~/.ssh entries (private keys NOT backed up):"]
    for f in sorted(ssh_dir.iterdir()):
        if f.is_file():
            kind = "pub" if f.suffix == ".pub" else "private — not backed up"
            lines.append(f"  {f.name}  ({kind})")

    payload = "\n".join(lines).encode()
    key = f"ssh-inventory/{TODAY}.txt"
    if upload(key, payload, "text/plain"):
        record_status("ssh-inventory", "ssh-inventory/", "weekly", 192, "success",
                      started, bytes_=len(payload), object_key=key)
    else:
        record_status("ssh-inventory", "ssh-inventory/", "weekly", 192, "failed",
                      started, bytes_=len(payload), object_key=key, error="upload failed")
        raise RuntimeError("ssh-inventory upload failed")


# ── 6. Claude harness config (daily) ──────────────────────────────────────────
CLAUDE_CONFIG_PATHS = [
    "~/.claude/CLAUDE.md",
    "~/.claude/settings.json",
    "~/.claude/scripts",      # session hooks, watchdog, etc.
    "~/.claude/agents",
    "~/.claude/commands",
]


def backup_claude_config() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    paths = [Path(p).expanduser() for p in CLAUDE_CONFIG_PATHS]
    existing = [p for p in paths if p.exists()]
    if not existing:
        log.warning("No Claude config paths found — skipping")
        record_status("claude-config", "claude-config/", "daily", 30, "skipped",
                      started, error="no paths found")
        return

    data = make_tarball(existing)
    key = f"claude-config/{TODAY}/claude-config.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("claude-config/", keep_days=14)
        record_status("claude-config", "claude-config/", "daily", 30, "success",
                      started, bytes_=len(data), object_key=key,
                      metadata={"paths": [str(p) for p in existing]})
    else:
        record_status("claude-config", "claude-config/", "daily", 30, "failed",
                      started, bytes_=len(data), object_key=key, error="upload failed")
        raise RuntimeError("claude-config upload failed")


# ── 7. Weekly full repo+state tarball (Sundays only) ──────────────────────────
WEEKLY_FULL_INCLUDE = [
    "~/azlab",                          # mono repo
    "~/dashboard",                      # dashboard source
    "~/.claude/CLAUDE.md",
    "~/.claude/settings.json",
    "~/.claude/scripts",
    "~/.claude/agents",
    "~/.claude/commands",
    "~/.config/systemd/user",           # all user-level service/timer units
]
WEEKLY_FULL_EXCLUDE_PATTERNS = (
    "node_modules", ".next", ".turbo", ".cache",
    "__pycache__", ".git/objects", "venv", ".venv",
    "data/users.db-wal", "data/users.db-shm",
    # Container bind-mount runtime state — owned by container UIDs, unreadable from host.
    # Important runtime state (lldap, traefik, supabase) has dedicated daily backup tasks.
    "services/code-server/config",
    "services/webtop/config",
    "services/monitoring/grafana/data",
)


def _tar_filter(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo | None:
    name = tarinfo.name
    for pat in WEEKLY_FULL_EXCLUDE_PATTERNS:
        if pat in name:
            return None
    return tarinfo


def backup_weekly_full() -> None:
    started = datetime.datetime.now(datetime.timezone.utc)
    if WEEKDAY != 6:
        log.info("  skipping (not Sunday)")
        record_status("weekly-full", "weekly-full/", "weekly", 192, "skipped",
                      started, error="not Sunday")
        return

    paths = [Path(p).expanduser() for p in WEEKLY_FULL_INCLUDE]
    existing = [p for p in paths if p.exists()]
    if not existing:
        log.warning("No weekly-full paths found — skipping")
        record_status("weekly-full", "weekly-full/", "weekly", 192, "skipped",
                      started, error="no paths found")
        return

    log.info(f"  building weekly-full tarball from {len(existing)} paths…")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=6) as tf:
        for p in existing:
            try:
                tf.add(str(p), arcname=p.name, filter=_tar_filter)
            except PermissionError as e:
                log.warning(f"  permission error adding {p}: {e}")
    data = buf.getvalue()

    key = f"weekly-full/{TODAY}.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("weekly-full/", keep_days=56)   # 8 weeks
        record_status("weekly-full", "weekly-full/", "weekly", 192, "success",
                      started, bytes_=len(data), object_key=key,
                      metadata={"paths": [str(p) for p in existing]})
    else:
        record_status("weekly-full", "weekly-full/", "weekly", 192, "failed",
                      started, bytes_=len(data), object_key=key, error="upload failed")
        raise RuntimeError("weekly-full upload failed")


# ── Staleness watchdog ────────────────────────────────────────────────────────
def _supabase_get(path: str) -> list | None:
    if not SUPABASE_URL or not SUPABASE_WRITE_KEY:
        return None
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
            headers={
                "apikey": SUPABASE_WRITE_KEY,
                "Authorization": f"Bearer {SUPABASE_WRITE_KEY}",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        log.warning(f"  Supabase GET {path} failed: {e}")
        return None


def _has_open_audit_task(name: str) -> bool:
    """Return True if an open audit task already exists for this backup name."""
    title_q = urllib.parse.quote(f"%backup failure: {name}%")
    rows = _supabase_get(
        f"task_queue?select=id,status,title"
        f"&status=in.(ready,in_progress_agent,in_progress_jeff,pending_jeff_action,review_needed,blocked,pending,claimed)"
        f"&title=ilike.{title_q}"
        f"&limit=1"
    )
    return bool(rows)


def check_staleness() -> int:
    """Read backup_status_latest; alert + queue audit task on overdue/failed entries.

    Skips firing if there's already an open audit task for that backup (avoids spam)."""
    rows = _supabase_get("backup_status_latest?select=*")
    if rows is None:
        return 0
    bad = [r for r in rows if r.get("health") in ("overdue", "never_succeeded", "failed")]
    for r in bad:
        reason = (
            f"health={r['health']}, last_success={r.get('last_success_at') or 'never'}, "
            f"expected every {r['expected_interval_hours']}h"
        )
        log.warning(f"  STALE: {r['name']} — {reason}")
        if _has_open_audit_task(r["name"]):
            log.info(f"  (open audit task already exists for {r['name']} — skipping notify)")
            continue
        notify_failure(r["name"], reason, {
            "prefix": r.get("prefix"),
            "last_success_at": r.get("last_success_at"),
            "last_error": r.get("last_error"),
            "health": r.get("health"),
        })
    return len(bad)


# ── Main ──────────────────────────────────────────────────────────────────────
TASKS = [
    ("Supabase tables",     backup_supabase),
    ("Traefik configs",     backup_traefik),
    ("AdGuard config",      backup_adguard),
    ("LLDAP data",          backup_lldap),
    ("Claude harness",      backup_claude_config),
    ("SSH key inventory",   backup_ssh_inventory),
    ("Weekly full tarball", backup_weekly_full),
]


def main() -> None:
    log.info(f"=== r2-backup start — {TODAY} (weekday={WEEKDAY}) ===")
    errors = 0
    failed_names = []
    for name, fn in TASKS:
        log.info(f"--- {name} ---")
        try:
            fn()
        except Exception as e:
            log.error(f"{name} unhandled error: {e}")
            errors += 1
            failed_names.append(name)
            notify_failure(name, f"unhandled exception: {e}", {"prefix": fn.__name__})

    log.info("--- staleness watchdog ---")
    stale = check_staleness()
    if stale:
        log.warning(f"  {stale} backup(s) flagged stale")

    if errors:
        log.warning(f"=== r2-backup done with {errors} error(s): {', '.join(failed_names)} ===")
        sys.exit(1)
    else:
        log.info("=== r2-backup done — all tasks succeeded ===")


if __name__ == "__main__":
    main()
