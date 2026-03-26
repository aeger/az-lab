#!/usr/bin/env python3
"""
Claude Code Task Queue Poller
Polls azlab-memory Supabase for pending tasks, claims and executes them,
then writes results back. Runs every 5 min via systemd timer.
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

def _load_supabase_key():
    # Prefer service key (bypasses RLS) from memory-mcp-server env file
    env_path = os.path.expanduser("~/azlab/services/memory-mcp-server/.env")
    try:
        with open(env_path) as f:
            for line in f:
                if line.startswith("SUPABASE_SERVICE_KEY="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    # Fall back to env var or hardcoded anon key
    return os.environ.get(
        "SUPABASE_KEY",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDU1NzYsImV4cCI6MjA4OTYyMTU3Nn0.VVvHOmcR04gnVHa6k8_lHhdCt6zNhpHYbj4c68LkScc",
    )

SUPABASE_KEY = _load_supabase_key()
CLAUDE_CMD = os.environ.get("CLAUDE_CMD", "claude")
HOSTNAME = socket.gethostname()

# Nemotron routing — NVIDIA NIM API for cheap task classification
NVIDIA_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_API_KEY_FILE = os.path.expanduser("~/.nvidia_api_key")
NEMOTRON_MODEL = "nvidia/nemotron-super-49b-instruct"

ROUTING_TARGETS = ["claude-code", "cowork", "desktop"]

ROUTING_PROMPT = """You are a task router for a homelab AI system. Classify the task below to exactly one target agent.

Targets:
- claude-code: Linux server ops, git, docker/podman, deployments, file edits, code, networking, infrastructure, APIs, scripting, anything on the homelab server
- desktop: Windows-only tasks, OneDrive, local Office files, anything requiring a Windows app or GUI
- cowork: Planning, research, writing docs, memory management, multi-turn conversational tasks, anything that needs discussion not execution

Respond with ONLY the target name, nothing else. No punctuation, no explanation.

Task title: {title}
Task description: {description}"""

# Discord notifications via webhook (more reliable than bot DMs)
DISCORD_WEBHOOK_FILE = os.path.expanduser("~/claude/agent-bus/discord_webhooks.json")

def _get_webhook_url():
    try:
        with open(DISCORD_WEBHOOK_FILE) as f:
            hooks = json.load(f)
            return hooks.get("claude-code")
    except Exception:
        return None

def discord_notify(message):
    """Post a notification to the claude-code Discord channel. Best-effort — never raises."""
    try:
        url = _get_webhook_url()
        if not url:
            return
        body = json.dumps({"content": message}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        print(f"discord_notify failed (non-fatal): {e}", file=sys.stderr)


def _get_nvidia_key():
    key = os.environ.get("NVIDIA_API_KEY")
    if key:
        return key
    try:
        with open(NVIDIA_API_KEY_FILE) as f:
            return f.read().strip()
    except Exception:
        return None


def _route_via_nemotron(title, description):
    """Ask Nemotron to classify the task. Returns target string or None on failure."""
    key = _get_nvidia_key()
    if not key:
        return None
    prompt = ROUTING_PROMPT.format(title=title, description=description[:500])
    body = json.dumps({
        "model": NEMOTRON_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 10,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        NVIDIA_NIM_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            answer = data["choices"][0]["message"]["content"].strip().lower()
            # Validate the response is a known target
            for t in ROUTING_TARGETS:
                if t in answer:
                    return t
            return None
    except Exception as e:
        print(f"Nemotron routing failed (non-fatal): {e}", file=sys.stderr)
        return None


def _route_by_keywords(title, description):
    """Fallback keyword-based routing when Nemotron is unavailable."""
    text = (title + " " + description).lower()
    desktop_signals = ["windows", "onedrive", "obsidian", "office", "excel", "word", "outlook", "c:\\", "appdata"]
    cowork_signals = ["plan", "research", "write up", "document", "memory", "draft", "review", "summarize", "brainstorm"]
    if any(s in text for s in desktop_signals):
        return "desktop"
    if any(s in text for s in cowork_signals):
        return "cowork"
    return "claude-code"  # default: if in doubt, we can handle it


def route_auto_tasks():
    """Find tasks with target=auto, classify them with Nemotron, update target."""
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "eq.pending",
            "target": "eq.auto",
            "order": "created_at.asc",
            "limit": "5",
            "select": "id,title,description",
        },
    )
    if not tasks:
        return

    for task in tasks:
        task_id = task["id"]
        title = task["title"]
        description = task.get("description", "")

        target = _route_via_nemotron(title, description) or _route_by_keywords(title, description)
        print(f"Auto-routing task {task_id[:8]} '{title}' → {target}")

        api_request(
            "PATCH",
            f"task_queue?id=eq.{task_id}",
            data={"target": target},
        )


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
    """Fetch the highest-priority pending or delegated task and claim it atomically."""
    # Pick up both 'pending' and 'delegated' tasks targeting claude-code
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "in.(pending,delegated)",
            "target": "eq.claude-code",
            "order": "priority.asc,created_at.asc",
            "limit": "1",
            "select": "id,title,description,context,priority,tags,status",
        },
    )
    if not tasks:
        return None

    task = tasks[0]
    task_id = task["id"]
    current_status = task.get("status", "pending")

    # Claim atomically — only succeeds if still in expected status
    claimed = api_request(
        "PATCH",
        f"task_queue?id=eq.{task_id}&status=eq.{current_status}",
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


def log_activity(activity_type, content, task_id=None, metadata=None):
    """Write a row to agent_activity. Best-effort — never raises."""
    try:
        data = {
            "agent": "wren",
            "activity_type": activity_type,
            "content": content,
        }
        if task_id:
            data["task_id"] = task_id
        if metadata:
            data["metadata"] = metadata
        api_request("POST", "agent_activity", data=data)
    except Exception as e:
        print(f"log_activity failed (non-fatal): {e}", file=sys.stderr)


def mark_in_progress(task_id):
    pass  # 'claimed' already signals in-progress; schema has no in_progress status


def mark_completed(task_id, result):
    api_request(
        "PATCH",
        f"task_queue?id=eq.{task_id}",
        data={"status": "completed", "result": result},
    )


def mark_failed(task_id, error):
    api_request(
        "PATCH",
        f"task_queue?id=eq.{task_id}",
        data={"status": "failed", "error": error},
    )


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


def run_claude(prompt):
    result = subprocess.run(
        [CLAUDE_CMD, "--print", "--dangerously-skip-permissions"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=600,  # 10 min max per task
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude exited {result.returncode}: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def main():
    print(f"[{datetime.now().isoformat()}] Polling task queue on {HOSTNAME}...")

    # Route any unclassified tasks first
    route_auto_tasks()

    task = claim_next_task()
    if not task:
        print("No pending tasks.")
        return

    task_id = task["id"]
    title = task["title"]
    print(f"Claimed task {task_id}: {title}")

    mark_in_progress(task_id)
    log_activity("status", f"Claimed: {title}", task_id=task_id)
    discord_notify(f"🟡 Claimed: {title} — starting now")

    try:
        prompt = build_prompt(task)
        print(f"Running claude for task: {title}")
        log_activity("thinking", f"Running Claude for: {title}", task_id=task_id)
        result = run_claude(prompt)
        mark_completed(task_id, result)
        summary = result.splitlines()[0][:120] if result else "done"
        log_activity("result", summary, task_id=task_id)
        discord_notify(f"✅ Done: {title} — {summary}")
        print(f"Task {task_id} completed.")
    except Exception as e:
        error_msg = str(e)
        print(f"Task {task_id} failed: {error_msg}", file=sys.stderr)
        mark_failed(task_id, error_msg)
        log_activity("error", error_msg[:200], task_id=task_id)
        discord_notify(f"❌ Failed: {title} — {error_msg[:120]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
