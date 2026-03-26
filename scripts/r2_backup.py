#!/usr/bin/env python3
"""r2_backup.py — az-lab R2 backup script

Backs up critical data to Cloudflare R2 (az-lab-backups bucket).
Run nightly at 02:00 UTC via claude-r2-backup.timer.

Backups:
  - Supabase tables (JSON export)          → supabase/YYYY-MM-DD.json        (daily, 7d retention)
  - Traefik dynamic configs + acme.json    → traefik/YYYY-MM-DD/*.tar.gz     (daily, 7d retention)
  - AdGuard Home rewrites + status         → adguard/YYYY-MM-DD/*.json       (daily, 7d retention)
  - LLDAP SQLite DB + config               → lldap/YYYY-MM-DD/*.tar.gz       (daily, 7d retention)
  - SSH key fingerprint inventory          → ssh-inventory/YYYY-MM-DD.txt    (weekly on Sunday)

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
import urllib.error
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
SUPABASE_KEY = env.get("SUPABASE_SERVICE_KEY", "")

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


def http_get(url: str, timeout: int = 10) -> bytes | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
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
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.warning("Supabase credentials missing — skipping")
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


# ── 2. Traefik config + acme.json ─────────────────────────────────────────────
def backup_traefik() -> None:
    base = Path.home() / "azlab/infrastructure/traefik"
    dynamic_dir = base / "dynamic"
    # acme.json may be in data/ or directly under traefik/
    acme_candidates = [base / "data" / "acme.json", base / "acme.json"]
    acme = next((p for p in acme_candidates if p.exists()), None)

    paths = sorted(dynamic_dir.glob("*.yml")) if dynamic_dir.exists() else []
    if acme:
        paths.append(acme)

    if not paths:
        log.warning("No Traefik files found — skipping")
        return

    data = make_tarball(paths)
    key = f"traefik/{TODAY}/traefik-configs.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("traefik/", keep_days=7)


# ── 3. AdGuard config + rewrites ──────────────────────────────────────────────
def backup_adguard() -> None:
    raw = http_get(f"{ADGUARD_URL}/control/rewrite/list")
    if raw is None:
        log.warning(f"AdGuard unreachable at {ADGUARD_URL} — skipping")
        return

    try:
        rewrites = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("AdGuard rewrite response not valid JSON — skipping")
        return

    status: dict = {}
    raw_status = http_get(f"{ADGUARD_URL}/control/status")
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


# ── 4. LLDAP data ─────────────────────────────────────────────────────────────
def backup_lldap() -> None:
    lldap_data = Path.home() / "azlab/services/lldap/data"
    paths = [lldap_data / "users.db", lldap_data / "lldap_config.toml"]
    existing = [p for p in paths if p.exists()]

    if not existing:
        log.warning("No LLDAP data files found — skipping")
        return

    data = make_tarball(existing)
    key = f"lldap/{TODAY}/lldap-data.tar.gz"
    if upload(key, data, "application/gzip"):
        prune("lldap/", keep_days=7)


# ── 5. SSH key inventory (weekly — Sundays only) ──────────────────────────────
def backup_ssh_inventory() -> None:
    if WEEKDAY != 6:
        log.info("  skipping (not Sunday)")
        return

    ssh_dir = Path.home() / ".ssh"
    if not ssh_dir.exists():
        log.warning("~/.ssh not found — skipping")
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
    upload(key, payload, "text/plain")


# ── Main ──────────────────────────────────────────────────────────────────────
TASKS = [
    ("Supabase tables", backup_supabase),
    ("Traefik configs", backup_traefik),
    ("AdGuard config", backup_adguard),
    ("LLDAP data", backup_lldap),
    ("SSH key inventory", backup_ssh_inventory),
]


def main() -> None:
    log.info(f"=== r2-backup start — {TODAY} (weekday={WEEKDAY}) ===")
    errors = 0
    for name, fn in TASKS:
        log.info(f"--- {name} ---")
        try:
            fn()
        except Exception as e:
            log.error(f"{name} unhandled error: {e}")
            errors += 1
    if errors:
        log.warning(f"=== r2-backup done with {errors} error(s) ===")
        sys.exit(1)
    else:
        log.info("=== r2-backup done — all tasks succeeded ===")


if __name__ == "__main__":
    main()
