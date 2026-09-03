#!/usr/bin/env python3
"""
Argus — always-on task orchestrator daemon for svc-podman-01.

Responsibilities:
  - Continuous poll loop (replaces the 5-min cron timer)
  - Concurrent task execution (up to MAX_WORKERS parallel claude sessions)
  - Stall detection: kills workers that exceed per-complexity thresholds
  - Stall recovery: retry up to max_attempts, then escalate to Jeff
  - Own heartbeat written to agent_heartbeat table
  - Hands pre-dispatch evaluation off to Sage (via pending_eval_pre)

Agent identity: Argus
Runs as: almty1 systemd user service on svc-podman-01
"""

import json
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

# Import all execution machinery from the existing poller
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from poll_queue import (
    api_request, build_prompt, run_claude, route_task,
    mark_completed, mark_failed, mark_pending_eval, mark_pending_jeff_action,
    _needs_jeff_input, auto_queue_from_goals, route_auto_tasks,
    notify_cowork_tasks, log_activity, discord_notify,
    HOSTNAME, SUPABASE_URL, SUPABASE_KEY,
    _RESULT_MAX_CHARS,
)

# ── Tuning constants ────────────────────────────────────────────────────────

MAX_WORKERS            = 1      # max concurrent claude processes (was 3 — Supabase usage 2026-05-29)
POLL_INTERVAL          = 60     # seconds between queue polls (was 30 — Supabase usage 2026-05-29)
HEARTBEAT_INTERVAL     = 300    # write heartbeat every 5 min
SIMPLE_STALL_SECS      = 1800   # 30 min — simple tasks
COMPLEX_STALL_SECS     = 7200   # 2 hr  — complex/CRIT tasks
SAGE_EVAL_LAG_SECS     = 120    # seconds to wait for Sage to pre-evaluate a new task
DISCORD_PROGRESS_SECS  = 900    # post a "still running" Discord update every 15 min

# ── State ───────────────────────────────────────────────────────────────────

# task_id → {thread, started_at, last_discord_at, task, stall_threshold}
_running: dict[str, dict] = {}
_lock = threading.Lock()


# ── Helpers ─────────────────────────────────────────────────────────────────

def _is_complex(task: dict) -> bool:
    """Classify task complexity for stall-threshold selection."""
    priority = task.get("priority", 2)
    tags = [t.lower() for t in (task.get("tags") or [])]
    desc = task.get("description") or ""
    return (
        priority == 0
        or "complex" in tags
        or len(desc) > 800
    )


# Consecutive failed heartbeat POSTs. See the matching note in sage.py — a
# swallowed heartbeat failure is what makes a network outage indistinguishable
# from a dead agent when a `silent_agent` kill switch fires.
_hb_fail_streak = 0


def _write_heartbeat(status: str = "active", metadata: dict | None = None) -> None:
    global _hb_fail_streak
    try:
        payload = json.dumps({
            "agent": "argus",
            "status": status,
            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {
                "host": HOSTNAME,
                "workers": len(_running),
                "max_workers": MAX_WORKERS,
            },
        }).encode()
        import urllib.request
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/agent_heartbeat?on_conflict=agent",
            data=payload,
            method="POST",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        _hb_fail_streak += 1
        if _hb_fail_streak == 1:
            print(f"[Argus] HEARTBEAT FAILED (1st consecutive) — {type(e).__name__}: {e}. "
                  f"Silence from here will look like a silent_agent anomaly; "
                  f"suspect network/WAN before suspecting Argus.", file=sys.stderr)
    else:
        if _hb_fail_streak:
            print(f"[Argus] HEARTBEAT RECOVERED after {_hb_fail_streak} "
                  f"consecutive failure(s).", file=sys.stderr)
            _hb_fail_streak = 0


def _reset_task_to_pending(task_id: str, reason: str) -> None:
    """Reset a stalled task back to pending so it can be retried."""
    try:
        rows = api_request("GET", "task_queue",
                           params={"id": f"eq.{task_id}",
                                   "select": "attempt_count,max_attempts,title,goal_id,priority"})
        if not rows:
            return
        task = rows[0]
        attempts = (task.get("attempt_count") or 0) + 1
        max_att = task.get("max_attempts") or 3
        title = task.get("title", task_id[:8])

        if attempts >= max_att:
            # Exhausted retries — escalate to Jeff
            api_request("PATCH", f"task_queue?id=eq.{task_id}", data={
                "status": "pending_jeff_action",
                "claimed_by": None,
                "claimed_at": None,
                "attempt_count": attempts,
                "error": f"Stalled after {attempts} attempt(s): {reason[:200]}",
            })
            log_activity("error", f"Stall escalated to Jeff after {attempts} attempts: {reason[:100]}", task_id=task_id)
            discord_notify(
                f"⚠️ **Stall → Jeff:** {title}\n"
                f"Stalled {attempts}/{max_att} attempts. Reason: `{reason[:120]}`\n"
                f"Task is now `pending_jeff_action`."
            )
        else:
            # Reset for retry
            api_request("PATCH", f"task_queue?id=eq.{task_id}", data={
                "status": "pending",
                "claimed_by": None,
                "claimed_at": None,
                "attempt_count": attempts,
                "error": f"Stall retry {attempts}/{max_att}: {reason[:200]}",
            })
            log_activity("error", f"Stall — reset to pending (attempt {attempts}/{max_att}): {reason[:100]}", task_id=task_id)
            discord_notify(
                f"🔄 **Stall retry {attempts}/{max_att}:** {title}\n"
                f"Reason: `{reason[:120]}`"
            )
    except Exception as e:
        print(f"_reset_task_to_pending failed for {task_id}: {e}", file=sys.stderr)


# ── Worker thread ────────────────────────────────────────────────────────────

def _worker(task: dict, stall_threshold: int = SIMPLE_STALL_SECS) -> None:
    """Execute a single claimed task. Runs in its own thread."""
    task_id = task["id"]
    title = task["title"]
    goal_id = task.get("goal_id")

    # Update task status to in_progress_agent
    try:
        api_request("PATCH", f"task_queue?id=eq.{task_id}", data={
            "status": "in_progress_agent",
            "claimed_by": HOSTNAME,
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        print(f"Worker: failed to set in_progress_agent for {task_id}: {e}", file=sys.stderr)

    log_activity("status", f"Argus dispatched: {title}", task_id=task_id)
    discord_notify(f"🟡 **Argus:** Dispatched `{title}`")

    def _register_proc(p):
        with _lock:
            entry = _running.get(task_id)
            if entry is not None:
                entry["proc"] = p

    try:
        # route_task returns str | None (the model id, None = claude binary default)
        # since aa95769 removed the dead Gemini runner and its {"runner","model"} dict.
        model = route_task(task)
        prompt = build_prompt(task)
        model_label = model or "sonnet (default)"
        log_activity("thinking", f"Starting [claude / {model_label}]: {title}", task_id=task_id)

        # Pass a 3× stall_threshold wall-clock backstop so the watchdog inside
        # run_claude SIGKILLs the subprocess even if Argus's stall monitor is
        # ever down or the orchestrator restart loses the proc handle.
        result = run_claude(
            prompt,
            task_id=task_id,
            model=model,
            proc_register=_register_proc,
            max_runtime=stall_threshold * 3,
        )

        # JeffLoop: detect if agent is asking Jeff a question
        jeff_needed, jeff_reason = _needs_jeff_input(result)
        if jeff_needed:
            mark_pending_jeff_action(task_id, result, jeff_reason, title=title, goal_id=goal_id)
            return

        # CRIT/HIGH → pending_eval (Sage will evaluate)
        task_priority = task.get("priority", 2)
        summary = result.splitlines()[0][:120] if result else "done"
        if task_priority <= 1:
            mark_pending_eval(task_id, result, goal_id=goal_id)
            discord_notify(f"🔍 **Pending eval:** {title} — {summary}")
        else:
            mark_completed(task_id, result, goal_id=goal_id)
            discord_notify(f"✅ **Done:** {title} — {summary}")

    except Exception as e:
        err = str(e)
        print(f"Worker error for {task_id}: {err}", file=sys.stderr)
        mark_failed(task_id, err, goal_id=goal_id)
        log_activity("error", err[:200], task_id=task_id)
        discord_notify(f"❌ **Failed:** {title} — {err[:120]}")
    finally:
        with _lock:
            _running.pop(task_id, None)


def _spawn_worker(task: dict) -> None:
    """Claim and spawn a worker thread for the given task."""
    task_id = task["id"]
    is_complex = _is_complex(task)
    threshold = COMPLEX_STALL_SECS if is_complex else SIMPLE_STALL_SECS

    t = threading.Thread(target=_worker, args=(task, threshold), name=f"argus-{task_id[:8]}", daemon=True)
    with _lock:
        _running[task_id] = {
            "thread": t,
            "started_at": time.time(),
            "last_discord_at": time.time(),
            "task": task,
            "stall_threshold": threshold,
            "is_complex": is_complex,
            "proc": None,  # populated by worker once subprocess.Popen returns
        }
    t.start()
    kind = "complex" if is_complex else "simple"
    print(f"[Argus] Spawned worker for {task_id[:8]} '{task['title']}' ({kind}, stall={threshold//60}min)")


# ── Stall monitor ────────────────────────────────────────────────────────────

def _check_stalls() -> None:
    """Scan running workers for stalls and post progress updates."""
    now = time.time()
    to_stall: list[tuple[str, dict]] = []

    with _lock:
        for task_id, info in list(_running.items()):
            thread = info["thread"]
            age = now - info["started_at"]

            # Post progress Discord ping every DISCORD_PROGRESS_SECS
            if now - info["last_discord_at"] >= DISCORD_PROGRESS_SECS:
                title = info["task"].get("title", task_id[:8])
                elapsed_min = int(age // 60)
                discord_notify(f"⏳ **Still running ({elapsed_min}min):** {title}")
                info["last_discord_at"] = now

            # Check stall
            if not thread.is_alive():
                # Thread finished — remove from tracking (worker cleans up itself but just in case)
                _running.pop(task_id, None)
                continue

            if age > info["stall_threshold"]:
                to_stall.append((task_id, info))

    for task_id, info in to_stall:
        title = info["task"].get("title", task_id[:8])
        age_min = int((now - info["started_at"]) // 60)
        kind = "complex" if info["is_complex"] else "simple"
        reason = f"No completion after {age_min}min ({kind} task, threshold={info['stall_threshold']//60}min)"
        print(f"[Argus] Stall detected: {task_id[:8]} '{title}' — {reason}")

        # Kill the running claude subprocess BEFORE resetting the task so the
        # next dispatch doesn't run alongside an orphaned process. Without this,
        # the old process can stay wedged at 100% CPU indefinitely (see
        # task 904b18ae, 2026-05-04: zombie ran 30+ hr at 101% CPU).
        proc = info.get("proc")
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.kill()
                    print(f"[Argus] Killed stalled PID {proc.pid} for task {task_id[:8]}")
                    log_activity("error", f"Stall: killed PID {proc.pid}", task_id=task_id)
            except Exception as e:
                print(f"[Argus] Failed to kill stalled proc for {task_id[:8]}: {e}", file=sys.stderr)
        else:
            print(f"[Argus] Stall on {task_id[:8]} but no proc handle registered — relying on run_claude watchdog", file=sys.stderr)

        _reset_task_to_pending(task_id, reason)
        with _lock:
            _running.pop(task_id, None)
        # Worker thread will now error out (broken pipe / EOF on stdout) and
        # clean up; new dispatch can safely pick up the reset task.


# ── Main loop ────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[Argus] Starting on {HOSTNAME} — max_workers={MAX_WORKERS}, poll={POLL_INTERVAL}s")
    # Fail-loud auth probe — bail if Supabase key isn't valid so systemd marks
    # the service as failed instead of letting Argus silent-loop on 401s.
    try:
        from poll_queue import verify_supabase_auth
        verify_supabase_auth()
        print("[Argus] Supabase auth OK")
    except Exception as e:
        print(f"[Argus] STARTUP FAILED — Supabase auth probe: {e}", file=sys.stderr)
        try:
            discord_notify(f"❌ **Argus startup failed** on `{HOSTNAME}`: {e}")
        except Exception:
            pass
        sys.exit(2)
    discord_notify(f"🦅 **Argus online** on `{HOSTNAME}` — max_workers={MAX_WORKERS}")
    _write_heartbeat("starting")

    last_heartbeat = 0.0

    while True:
        try:
            now = time.time()

            # Heartbeat
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                _write_heartbeat()
                last_heartbeat = now

            # Check stalls / post progress
            _check_stalls()

            # Capacity check
            with _lock:
                active = len(_running)

            if active < MAX_WORKERS:
                # Housekeeping (routing, cowork notifications, goal auto-queue)
                route_auto_tasks()
                notify_cowork_tasks()

                task = None
                # Claim next available task
                try:
                    task = _claim_next_for_argus()
                except Exception as e:
                    print(f"[Argus] claim error: {e}", file=sys.stderr)

                if task:
                    _spawn_worker(task)
                else:
                    # Nothing to run — try promoting goals
                    auto_queue_from_goals()
            else:
                print(f"[Argus] At capacity ({active}/{MAX_WORKERS} workers running), skipping claim.")

        except Exception as e:
            print(f"[Argus] Loop error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            _write_heartbeat("error", {"error": str(e)[:200]})

        time.sleep(POLL_INTERVAL)


def _claim_next_for_argus():
    """Claim the next pending/ready task targeted at wren/claude-code."""
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "in.(ready,pending)",
            "target": "in.(claude-code,wren)",
            "archived_at": "is.null",
            "order": "priority.asc,created_at.asc",
            "limit": "1",
            "select": "id,title,description,context,priority,tags,status,goal_id,attempt_count,error,result,recurring",
        },
    )
    if not tasks:
        return None

    task = tasks[0]
    task_id = task["id"]
    current_status = task["status"]

    # Idempotency boundary (2026-08-29): a non-recurring task that already has a
    # result is finished work — refuse to dispatch it again. A deliberate re-run
    # clears result (dashboard reopen) or carries the premise-accepted tag
    # (premise_decide). Mirrors the identical guard in poll_queue.py.
    if (
        not task.get("recurring")
        and (task.get("result") or "").strip()
        and "premise-accepted" not in (task.get("tags") or [])
    ):
        bounced = api_request(
            "PATCH",
            f"task_queue?id=eq.{task_id}&status=eq.{current_status}",
            data={
                "status": "pending_jeff_action",
                "blocked_reason": "idempotency guard: non-recurring task already has a result; "
                                  "re-run refused. Reopen it (which clears result) to run again.",
            },
        )
        if bounced:
            log_activity(
                "status",
                f"Idempotency guard: refused re-dispatch of finished task, bounced {current_status} -> pending_jeff_action: "
                f"{(task.get('title') or '')[:120]}",
                task_id=task_id,
            )
            print(f"[Argus] Task {task_id} has a result and is not recurring — re-dispatch refused, bounced to pending_jeff_action.")
        return None

    # Atomic claim — only succeeds if still in expected status
    claimed = api_request(
        "PATCH",
        f"task_queue?id=eq.{task_id}&status=eq.{current_status}",
        data={
            "status": "claimed",
            "claimed_by": f"{HOSTNAME}/argus",
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if not claimed:
        print(f"[Argus] Task {task_id} already claimed by another instance, skipping.")
        return None

    return task


if __name__ == "__main__":
    main()
