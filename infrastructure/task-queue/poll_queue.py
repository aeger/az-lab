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

def _read_file(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return f.read().strip()
    except Exception:
        return None


SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"
SUPABASE_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDU1NzYsImV4cCI6MjA4OTYyMTU3Nn0.VVvHOmcR04gnVHa6k8_lHhdCt6zNhpHYbj4c68LkScc",
)
CLAUDE_CMD = os.environ.get("CLAUDE_CMD", "claude")
HOSTNAME = socket.gethostname()

# NVIDIA NIM for nemotron routing
NEMOTRON_MODEL = "nvidia/nemotron-3-super-120b-a12b"
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY") or _read_file("~/.nvidia_api_key")
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


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
    """Call NVIDIA NIM (Nemotron 120B) directly via the OpenAI-compatible API.
    Falls back to Claude if the API call fails.
    """
    if not NVIDIA_API_KEY:
        print("No NVIDIA API key found, falling back to Claude.", file=sys.stderr)
        return run_claude(prompt)

    payload = json.dumps({
        "model": NEMOTRON_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 4096,
        "temperature": 0.6,
        "top_p": 0.9,
    }).encode()

    req = urllib.request.Request(
        f"{NVIDIA_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
            return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"Nemotron API error, falling back to Claude: {e}", file=sys.stderr)
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
