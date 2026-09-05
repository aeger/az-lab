#!/usr/bin/env python3
"""One-shot unblocker for the 08-26 eval read-back task.

poll_queue.py has no time gating (it claims status in (ready,pending,delegated)
ordered by priority), so the read-back task is parked as `blocked` until the
datapoint it reads actually exists. This flips it to `pending` -- but only once
eval_nightly.log really has a run newer than the 08-25 05:00:54 one, so a night
where the eval unit never fired does not burn the task's attempts.
"""
import os, re, sys, json, urllib.request

TASK_ID = "ff8c500d-92bd-476d-88ef-63064f175fb7"
LOG = os.path.expanduser("~/azlab/services/memory-mcp-server/eval_nightly.log")
AFTER = "2026-08-25T05:00:54Z"
URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"

def key():
    with open(os.path.expanduser("~/azlab/services/memory-mcp-server/.env")) as f:
        for line in f:
            if line.startswith("SUPABASE_SECRET_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("no SUPABASE_SECRET_KEY")

runs = re.findall(r"^=== (\S+) nightly eval", open(LOG).read(), re.M)
if not runs or runs[-1] <= AFTER:
    print(f"eval has not run yet (newest={runs[-1] if runs else 'none'}) — leaving task blocked")
    sys.exit(75)   # EX_TEMPFAIL: timer retries via its next activation

k = key()
req = urllib.request.Request(
    f"{URL}/rest/v1/task_queue?id=eq.{TASK_ID}&status=eq.blocked",
    data=json.dumps({"status": "pending", "blocked_reason": None}).encode(),
    method="PATCH",
    headers={"apikey": k, "Authorization": f"Bearer {k}",
             "Content-Type": "application/json", "Prefer": "return=representation"},
)
with urllib.request.urlopen(req, timeout=30) as r:
    body = r.read().decode()
print(f"unblocked (newest run {runs[-1]}): {body[:200]}")
