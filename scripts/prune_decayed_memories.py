#!/usr/bin/env python3
"""
Nightly cleanup: prune fully-decayed memories from Supabase azlab-memory.

Deletes memories where:
  - access_count = 0 (never accessed via recall)
  - last_accessed_at older than 30 days
  - importance_score < 0.3 (low importance or using default 0.5 threshold — conservative)
  - updated_at older than 30 days

Runs nightly at 02:00 UTC via crontab.
Logs to /home/almty1/azlab/scripts/prune_decayed_memories.log
"""

import os
import sys
import json
import urllib.request
import urllib.error
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY_FILE = os.path.expanduser("~/azlab/services/memory-mcp-server/.env")

def load_service_key():
    """Load SUPABASE_SECRET_KEY from .env file."""
    if os.path.exists(SUPABASE_KEY_FILE):
        with open(SUPABASE_KEY_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("SUPABASE_SECRET_KEY="):
                    return line.split("=", 1)[1].strip()
    return os.environ.get("SUPABASE_SECRET_KEY", "")

def call_rpc(service_key: str, function_name: str, params: dict) -> dict:
    """Call a Supabase RPC function."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/{function_name}"
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode())}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"status": e.code, "error": body}
    except Exception as e:
        return {"status": -1, "error": str(e)}

def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    service_key = load_service_key()
    if not service_key:
        print(f"[{ts}] ERROR: SUPABASE_SECRET_KEY not found in {SUPABASE_KEY_FILE}", flush=True)
        sys.exit(1)

    # Call the prune_decayed_memories() SECURITY DEFINER function
    result = call_rpc(service_key, "prune_decayed_memories", {
        "min_age_days": 30,
        "max_access_count": 0
    })

    if result.get("status", -1) < 0 or "error" in result:
        error_body = result.get("error", "unknown")
        # PGRST202 means the function doesn't exist yet (migration not applied)
        if "PGRST202" in error_body or "not found" in error_body.lower():
            print(f"[{ts}] SKIP: prune_decayed_memories() not found — apply migrations/003_adaptive_decay.sql first", flush=True)
            sys.exit(0)
        print(f"[{ts}] ERROR: RPC failed: {error_body}", flush=True)
        sys.exit(1)

    deleted_count = result.get("body", 0)
    print(f"[{ts}] Pruned {deleted_count} decayed memories (access_count=0, age>30d, importance<0.3)", flush=True)

if __name__ == "__main__":
    main()
