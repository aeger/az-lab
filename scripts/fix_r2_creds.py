#!/usr/bin/env python3
"""fix_r2_creds.py — apply an R2 S3 credential across all az-lab consumers.

CORRECTED 2026-07-10: the 2026-07-09 "token revoked, Jeff must mint" story was a
MISDIAGNOSIS. The Jul-08 consolidation *rolled* the `az-lab-claude-main` Cloudflare
API token (its id is unchanged and still the live R2_ACCESS_KEY_ID; the token is
still active). R2's S3 Secret Access Key = SHA-256(token value); .env just held the
SHA-256 of the pre-roll value, hence SignatureDoesNotMatch (NOT InvalidAccessKeyId).
No dashboard mint is needed — the credential is derivable on-host:

    KEYID=$(curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
              -H "Authorization: Bearer $(cat ~/.cloudflare/az-lab-claude-main.token)" \
              | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["id"])')
    SECRET=$(sha256sum < ~/.cloudflare/az-lab-claude-main.token | awk '{print $1}')

USAGE:
  1. Build a drop file, access key id line 1, secret line 2:
        printf '%s\n%s\n' "$KEYID" "$SECRET" > ~/.secret-drop/r2
  2. python3 ~/azlab/scripts/fix_r2_creds.py ~/.secret-drop/r2
  (Only fall back to a dashboard-minted R2 token if the az-lab-claude-main token is
   itself deleted — verify with user/tokens/verify first.)

The script: validates against az-lab-backups, rewrites all consumer configs
(value find/replace), updates the credentials store, restarts consumers,
re-runs the backup, and shreds the drop file. Never echoes secret values.
"""
import os, sys, json, subprocess, urllib.request
from pathlib import Path

HOME = Path.home()
ENV_FILES = [
    HOME / "azlab/services/memory-mcp-server/.env",
    HOME / "azlab/services/gmail-mcp-server/.env",
]
RCLONE = HOME / ".config/rclone/rclone.conf"

def die(msg): print(f"ERROR: {msg}"); sys.exit(1)

if len(sys.argv) != 2:
    die("usage: fix_r2_creds.py <drop-file-with-accesskey-line1-secret-line2>")
drop = Path(sys.argv[1])
if not drop.exists(): die(f"drop file not found: {drop}")
lines = [l.strip() for l in drop.read_text().splitlines() if l.strip()]
if len(lines) < 2: die("drop file must have access key on line 1, secret on line 2")
NEW_AK, NEW_SK = lines[0], lines[1]
print(f"read drop: access_key len={len(NEW_AK)}, secret len={len(NEW_SK)}")

# load env for account id + supabase
env = {}
for line in ENV_FILES[0].read_text().splitlines():
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); env[k] = v
ACCT = env["R2_ACCOUNT_ID"]
OLD_AK = env["R2_ACCESS_KEY_ID"]; OLD_SK = env["R2_SECRET_ACCESS_KEY"]

# 1) validate new creds against az-lab-backups
import boto3
from botocore.config import Config
s3 = boto3.client("s3", region_name="auto",
    endpoint_url=f"https://{ACCT}.r2.cloudflarestorage.com",
    aws_access_key_id=NEW_AK, aws_secret_access_key=NEW_SK,
    config=Config(signature_version="s3v4"))
s3.put_object(Bucket="az-lab-backups", Key="_healthcheck/wren-probe.txt", Body=b"ok")
s3.delete_object(Bucket="az-lab-backups", Key="_healthcheck/wren-probe.txt")
print("validate: PutObject/DeleteObject on az-lab-backups OK")

# 2) rewrite consumer configs by value replacement
def replace_in(path: Path):
    if not path.exists(): print(f"  skip (missing): {path}"); return
    t = path.read_text(); orig = t
    t = t.replace(OLD_AK, NEW_AK).replace(OLD_SK, NEW_SK)
    if t != orig:
        path.write_text(t); print(f"  updated: {path}")
    else:
        print(f"  no change: {path}")
print("rewriting configs:")
for p in ENV_FILES + [RCLONE]:
    replace_in(p)

# 3) update credentials store (needs admin token drop at ~/.secret-drop/az-admin-token)
admin_f = HOME / ".secret-drop/az-admin-token"
SUPA = env["SUPABASE_URL"]; KEY = env["SUPABASE_SECRET_KEY"]
MK = (HOME / ".az-cred-key").read_text().strip()
if admin_f.exists():
    admin = admin_f.read_text().strip()
    def upsert(name, secret, notes):
        body = json.dumps({"p_admin_token": admin, "p_master_key": MK, "p_name": name,
            "p_secret": secret, "p_notes": notes}).encode()
        req = urllib.request.Request(SUPA.rstrip("/") + "/rest/v1/rpc/upsert_credential",
            data=body, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json"})
        urllib.request.urlopen(req); print(f"  store upsert OK: {name}")
    upsert("r2-az-lab-memory-access-key", NEW_AK,
        f"Cloudflare R2 access key ID (account {ACCT}); rotated 2026-07-09. Source: memory-mcp/.env")
    upsert("r2-az-lab-memory-secret-key", NEW_SK,
        f"Cloudflare R2 secret access key (account {ACCT}); rotated 2026-07-09. Source: memory-mcp/.env")
    subprocess.run(["shred", "-u", str(admin_f)])
else:
    print("  SKIP store update (no ~/.secret-drop/az-admin-token) — update manually later")

# 4) restart long-running consumers that cache R2 creds
for c in ("az-memory-mcp", "az-gmail-mcp"):
    r = subprocess.run(["podman", "restart", c], capture_output=True, text=True)
    print(f"  restart {c}: {'OK' if r.returncode==0 else r.stderr.strip()[:80]}")

# 5) re-run the backup
print("re-running claude-r2-backup.service ...")
subprocess.run(["systemctl", "--user", "start", "claude-r2-backup.service"])
subprocess.run(["systemctl", "--user", "status", "claude-r2-backup.service", "--no-pager", "-n", "3"])

# 6) shred the drop
subprocess.run(["shred", "-u", str(drop)])
print("DONE — drop shredded. Check: journalctl --user -u claude-r2-backup.service -n 20")
