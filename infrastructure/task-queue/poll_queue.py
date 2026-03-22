#!/usr/bin/env python3
"""
Claude Code Task Queue Poller
Polls azlab-memory Supabase for pending tasks, claims and executes them,
then writes results back. Runs every 5 min via systemd timer.

Model routing:
  - Default / tags=["claude"]: run local claude CLI
  - tags=["nemotron"]: call NVIDIA NIM API via nemoclaw-01 (free inference)
"""

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"
SUPABASE_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDU1NzYsImV4cCI6MjA4OTYyMTU3Nn0.VVvHOmcR04gnVHa6k8_lHhdCt6zNhpHYbj4c68LkScc",
)
CLAUDE_CMD = os.environ.get("CLAUDE_CMD", "claude")
NEMOCLAW_HOST = os.environ.get("NEMOCLAW_HOST", "192.168.1.183")
NEMOCLAW_USER = os.environ.get("NEMOCLAW_USER", "ubuntu")
NEMOCLAW_KEY = os.environ.get("NEMOCLAW_KEY", os.path.expanduser("~/.ssh/id_ed25519_claude_desktop"))
HOSTNAME = socket.gethostname()

# NVIDIA NIM model for nemotron routing
NEMOTRON_MODEL = "nvidia/nemotron-3-super-120b-a12b"
NEMOTRON_SANDBOX = "az-labclaw"


def headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if extra:
        h.update(extra)
    return h


def api_request(method, path, data=None, params=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers(), method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {path}: {e.read().decode()}", file=sys.stderr)
        raise


def claim_next_task():
    """Fetch the highest-priority pending task and claim it atomically."""
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "eq.pending",
            "target": "eq.claude-code",
            "order": "priority.asc,created_at.asc",
            "limit": "1",
            "select": "id,title,description,context,priority,tags",
        },
    )
    if not tasks:
        return None

    task = tasks[0]
    task_id = task["id"]

    claimed = api_request(
        "PATCH",
        f"task_queue?id=eq.{task_id}&status=eq.pending",
        data={
            "status": "claimed",
            "claimed_by": HOSTNAME,
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if not claimed:
        print(f"Task {task_id} already claimed by another instance, skipping.")
        return None

    return task


def mark_in_progress(task_id):
    api_request("PATCH", f"task_queue?id=eq.{task_id}", data={"status": "in_progress"})


def mark_completed(task_id, result, model_used=None):
    data = {"status": "completed", "result": result}
    if model_used:
        data["result"] = f"[model: {model_used}]\n\n{result}"
    api_request("PATCH", f"task_queue?id=eq.{task_id}", data=data)


def mark_failed(task_id, error):
    api_request("PATCH", f"task_queue?id=eq.{task_id}", data={"status": "failed", "error": error})


def build_prompt(task):
    context = task.get("context") or {}
    context_str = ""
    if context:
        context_str = "\n\nContext:\n" + json.dumps(context, indent=2)

    return (
        f"Task: {task['title']}\n\n"
        f"{task['description']}"
        f"{context_str}\n\n"
        "Complete this task. Be concise in your response — summarize what you did."
    )


def select_model(task):
    """Choose execution model based on task tags and context."""
    tags = task.get("tags") or []
    context = task.get("context") or {}

    if "nemotron" in tags or context.get("model") == "nemotron":
        return "nemotron"
    return "claude"


def run_claude(prompt):
    """Run task with local Claude Code."""
    result = subprocess.run(
        [CLAUDE_CMD, "--print", "--dangerously-skip-permissions"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout.strip()


def run_nemotron(prompt):
    """Run task via NVIDIA NIM through the az-labclaw sandbox on nemoclaw-01.
    Uses openclaw inside the sandbox which routes to Nemotron 120B (free inference).
    """
    # Build a Python script to run inside the sandbox via SSH
    # openclaw reads from stdin and writes to stdout
    script = f"""
import subprocess, sys
result = subprocess.run(
    ["sudo", "nemoclaw", "{NEMOTRON_SANDBOX}", "connect", "--", "openclaw", "run", "--stdin"],
    input={json.dumps(prompt)},
    capture_output=True, text=True, timeout=300
)
if result.returncode != 0:
    print("ERROR: " + result.stderr, file=sys.stderr)
    sys.exit(1)
print(result.stdout)
"""
    try:
        result = subprocess.run(
            [
                "ssh",
                "-i", NEMOCLAW_KEY,
                "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=10",
                f"{NEMOCLAW_USER}@{NEMOCLAW_HOST}",
                "python3", "-c", script,
            ],
            capture_output=True,
            text=True,
            timeout=360,
        )
        if result.returncode != 0:
            # Fall back to claude if nemotron fails
            print(f"Nemotron failed, falling back to Claude: {result.stderr.strip()}", file=sys.stderr)
            return run_claude(prompt)
        return result.stdout.strip()
    except Exception as e:
        print(f"Nemotron SSH error, falling back to Claude: {e}", file=sys.stderr)
        return run_claude(prompt)


def main():
    print(f"[{datetime.now().isoformat()}] Polling task queue on {HOSTNAME}...")

    task = claim_next_task()
    if not task:
        print("No pending tasks.")
        return

    task_id = task["id"]
    model = select_model(task)
    print(f"Claimed task {task_id}: {task['title']} [model: {model}]")

    mark_in_progress(task_id)

    try:
        prompt = build_prompt(task)
        if model == "nemotron":
            print(f"Running nemotron (az-labclaw) for task: {task['title']}")
            result = run_nemotron(prompt)
        else:
            print(f"Running claude for task: {task['title']}")
            result = run_claude(prompt)

        mark_completed(task_id, result, model_used=model)
        print(f"Task {task_id} completed [{model}].")
    except Exception as e:
        error_msg = str(e)
        print(f"Task {task_id} failed: {error_msg}", file=sys.stderr)
        mark_failed(task_id, error_msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
