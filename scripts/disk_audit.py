#!/usr/bin/env python3
"""
disk_audit.py — Scheduled root disk space audit and auto-cleanup.

Runs daily. If disk usage exceeds WARNING_PCT, prunes podman images/volumes.
If usage still exceeds CRITICAL_PCT after cleanup, sends a Discord alert.
Always logs a brief status to Supabase agent_activity.
"""

import os
import shutil
import subprocess
import sys
import json
import urllib.request
from datetime import datetime, timezone

# ── Config ─────────────────────────────────────────────────────────────────────
WARNING_PCT   = 75   # start cleaning up
CRITICAL_PCT  = 85   # alert to Discord after cleanup
DISCORD_CHANNEL = "1012721652049657896"

SUPABASE_URL     = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
AGENT_BUS_URL    = "http://localhost:8765"

# ── Helpers ────────────────────────────────────────────────────────────────────

def disk_pct(path="/"):
    total, used, free = shutil.disk_usage(path)
    return round(used / total * 100, 1), used, total, free


def run(cmd, **kwargs):
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    return result.stdout.strip(), result.returncode


def send_discord(msg):
    try:
        payload = json.dumps({"channel_id": DISCORD_CHANNEL, "content": msg}).encode()
        req = urllib.request.Request(
            f"{AGENT_BUS_URL}/discord/send",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"[disk_audit] Discord send failed: {e}", file=sys.stderr)


def log_supabase(content, metadata=None):
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        return
    try:
        body = json.dumps({
            "agent": "wren",
            "activity_type": "status",
            "content": content,
            "metadata": metadata or {},
        }).encode()
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/agent_activity",
            data=body,
            headers={
                "Content-Type": "application/json",
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "Prefer": "return=minimal",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"[disk_audit] Supabase log failed: {e}", file=sys.stderr)


def bytes_to_gb(b):
    return round(b / 1_073_741_824, 1)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    pct_before, used_before, total, free_before = disk_pct("/")
    freed_gb = 0.0
    actions = []

    print(f"[disk_audit] {now} — disk at {pct_before}% ({bytes_to_gb(free_before)}G free)")

    if pct_before >= WARNING_PCT:
        # 1. Prune dangling podman images
        out, rc = run(["podman", "image", "prune", "-f"])
        if rc == 0:
            actions.append("pruned dangling images")
            print(f"[disk_audit] image prune: {out[:200] if out else 'nothing pruned'}")

        # 2. Prune unused podman volumes
        out, rc = run(["podman", "volume", "prune", "-f"])
        if rc == 0:
            actions.append("pruned unused volumes")
            print(f"[disk_audit] volume prune: {out[:200] if out else 'nothing pruned'}")

        # 3. Clean podman build cache
        out, rc = run(["podman", "system", "prune", "--volumes", "-f"])
        if rc == 0:
            actions.append("pruned build cache")

        pct_after, _, _, free_after = disk_pct("/")
        freed_gb = bytes_to_gb(free_after - free_before)
        print(f"[disk_audit] after cleanup: {pct_after}% ({bytes_to_gb(free_after)}G free, freed {freed_gb}G)")
    else:
        pct_after = pct_before

    # ── Compose status message ────────────────────────────────────────────────
    status_line = f"disk_audit {now}: {pct_before}% → {pct_after}% root"
    if freed_gb > 0:
        status_line += f" (freed {freed_gb}G)"
    if actions:
        status_line += f" | actions: {', '.join(actions)}"

    log_supabase(status_line, {
        "pct_before": pct_before,
        "pct_after": pct_after,
        "freed_gb": freed_gb,
        "total_gb": bytes_to_gb(total),
        "free_gb": bytes_to_gb(disk_pct("/")[3]),
    })

    # ── Alert if still critical ───────────────────────────────────────────────
    if pct_after >= CRITICAL_PCT:
        msg = (
            f"🚨 **Disk Alert — root at {pct_after}%** ({bytes_to_gb(disk_pct('/')[3])}G free)\n"
            f"Auto-cleanup ran but disk is still above {CRITICAL_PCT}%. Manual intervention needed.\n"
            f"Actions taken: {', '.join(actions) if actions else 'none'}\n"
            f"Check: `df -h /` and `du -sh /var/log/*`"
        )
        send_discord(msg)
        print(f"[disk_audit] ALERT sent — {pct_after}% after cleanup")
    elif pct_after >= WARNING_PCT and actions:
        # Cleanup ran and helped — send a quieter notice
        msg = (
            f"🧹 **Disk Cleanup** — root was at {pct_before}%, now {pct_after}% (freed {freed_gb}G)\n"
            f"Actions: {', '.join(actions)}"
        )
        send_discord(msg)

    print(f"[disk_audit] done — {status_line}")


if __name__ == "__main__":
    main()
