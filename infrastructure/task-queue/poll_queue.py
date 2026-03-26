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


# ── autonomous work loop ─────────────────────────────────────────────────────

# Phoenix AZ is UTC-7 (no DST). Morning review window: 7:00–8:00 local = 14:00–15:00 UTC.
MORNING_WINDOW_START_UTC = 14   # 7am Phoenix
MORNING_WINDOW_END_UTC   = 15   # 8am Phoenix

RESEARCH_COOLDOWN_HOURS = 20    # Only auto-queue research once per day

def _in_morning_window() -> bool:
    """Return True during Jeff's 7am review window (don't auto-generate work)."""
    hour = datetime.now(timezone.utc).hour
    return MORNING_WINDOW_START_UTC <= hour < MORNING_WINDOW_END_UTC


def _has_recent_pending_task(goal_id: str) -> bool:
    """Return True if goal already has a pending/claimed/failed task queued recently."""
    try:
        tasks = api_request(
            "GET",
            "task_queue",
            params={
                "goal_id": f"eq.{goal_id}",
                "status": "in.(pending,claimed,failed)",
                "select": "id",
                "limit": "1",
            },
        )
        return bool(tasks)
    except Exception:
        return True  # On error, assume task exists to avoid duplicates


def auto_queue_from_goals():
    """Find the highest-priority active milestone with an implementation_prompt and queue it."""
    if _in_morning_window():
        print("In morning review window — skipping auto-queue.")
        return None

    try:
        milestones = api_request(
            "GET",
            "goals",
            params={
                "level": "eq.milestone",
                "status": "eq.active",
                "auto_queue": "eq.true",
                "implementation_prompt": "not.is.null",
                "order": "priority.asc,sort_order.asc",
                "limit": "5",
                "select": "id,title,implementation_prompt,last_queued_at,priority",
            },
        )
    except Exception as e:
        print(f"auto_queue_from_goals: failed to fetch goals: {e}", file=sys.stderr)
        return None

    for m in milestones:
        goal_id = m["id"]
        title = m["title"]

        # Skip if queued recently (within last 6 hours)
        if m.get("last_queued_at"):
            last = datetime.fromisoformat(m["last_queued_at"].replace("Z", "+00:00"))
            hours_ago = (datetime.now(timezone.utc) - last).total_seconds() / 3600
            if hours_ago < 6:
                continue

        # Skip if already has a pending/claimed task
        if _has_recent_pending_task(goal_id):
            continue

        # Queue it
        task_data = {
            "title": f"[Auto] {title}",
            "description": m["implementation_prompt"],
            "status": "pending",
            "target": "claude-code",
            "source": "wren-scheduler",
            "priority": m["priority"],
            "goal_id": goal_id,
            "tags": ["auto-queued", "goal-milestone"],
        }
        try:
            result = api_request("POST", "task_queue", data=task_data)
            task_id = result[0]["id"] if isinstance(result, list) else result.get("id")
            # Update last_queued_at on goal
            api_request("PATCH", f"goals?id=eq.{goal_id}",
                        data={"last_queued_at": datetime.now(timezone.utc).isoformat()})
            print(f"Auto-queued goal milestone: {title} (task {task_id})")
            log_activity("status", f"Auto-queued: {title}", task_id=task_id)
            discord_notify(f"📋 Auto-queued: {title} — picked from goals backlog")
            return task_id
        except Exception as e:
            print(f"auto_queue_from_goals: failed to queue {goal_id}: {e}", file=sys.stderr)

    return None


def _research_recently_queued() -> bool:
    """Return True if a self-improvement research task was queued recently."""
    try:
        tasks = api_request(
            "GET",
            "task_queue",
            params={
                "tags": "cs.{self-improvement-research}",
                "order": "created_at.desc",
                "select": "created_at",
                "limit": "1",
            },
        )
        if not tasks:
            return False
        last = datetime.fromisoformat(tasks[0]["created_at"].replace("Z", "+00:00"))
        hours_ago = (datetime.now(timezone.utc) - last).total_seconds() / 3600
        return hours_ago < RESEARCH_COOLDOWN_HOURS
    except Exception:
        return False


def auto_queue_research():
    """When nothing else to do, queue a self-improvement research task for Iris."""
    if _in_morning_window():
        return
    if _research_recently_queued():
        print("Research task already queued recently — skipping.")
        return

    task_data = {
        "title": "Daily self-improvement research — agentic workflows and AI",
        "description": (
            "Research today's developments in agentic AI systems, workflows, memory architectures, "
            "and homelab automation. Focus on:\n"
            "1. Any new papers, releases, or tools in agent memory and context management\n"
            "2. New agent orchestration frameworks or significant updates to existing ones\n"
            "3. Hardware/compute breakthroughs relevant to running AI locally\n"
            "4. Practical improvements to multi-agent coordination patterns\n\n"
            "Synthesize findings into 3-5 actionable recommendations for az-lab. "
            "Post a summary to Discord (chat_id 1012721652049657896). "
            "Save notable findings as memories in Supabase (type=project, tags=['memory','research','ai']). "
            "If you find anything that represents a SEISMIC SHIFT — major model release, breakthrough hardware, "
            "paradigm change in agent architecture — flag it explicitly in Discord with 🚨 and high urgency."
        ),
        "status": "pending",
        "target": "cowork",
        "source": "wren-scheduler",
        "priority": 3,
        "tags": ["self-improvement-research", "daily", "auto-queued"],
    }
    try:
        result = api_request("POST", "task_queue", data=task_data)
        task_id = result[0]["id"] if isinstance(result, list) else result.get("id")
        print(f"Auto-queued daily research task {task_id}")
        log_activity("status", "Queue idle — auto-queued daily research for Iris")
    except Exception as e:
        print(f"auto_queue_research failed: {e}", file=sys.stderr)


def main():
    print(f"[{datetime.now().isoformat()}] Polling task queue on {HOSTNAME}...")

    # Route any unclassified tasks first
    route_auto_tasks()

    task = claim_next_task()
    if not task:
        print("No pending tasks.")
        # Try to auto-queue from goals backlog
        queued = auto_queue_from_goals()
        if not queued:
            # Nothing in goals either — queue research fallback
            auto_queue_research()
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
