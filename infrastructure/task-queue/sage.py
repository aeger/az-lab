#!/usr/bin/env python3
"""
Sage — always-on task evaluator agent for az-lab.

Responsibilities:
  1. Pre-dispatch complexity scoring: tag new pending tasks with
     complexity/safety metadata so Argus can set the right stall threshold.
  2. Post-execution evaluation: handle pending_eval tasks
     (auto-complete LOW/MED results; escalate risky/incomplete to Jeff).
  3. Task splitting: if a task is too large, split it into subtasks.
  4. Safety nets: detect dangerous operations before dispatch.
  5. Own heartbeat written to agent_heartbeat.

Agent identity: Sage
Runs as: almty1 systemd user service on svc-podman-01
"""

import json
import re
import sys
import time
import traceback
from datetime import datetime, timezone

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from poll_queue import (
    api_request, discord_notify, log_activity,
    _route_via_nemotron, HOSTNAME, SUPABASE_URL, SUPABASE_KEY,
    NEMOTRON_MODEL, _get_nvidia_key, mark_completed, mark_pending_jeff_action,
    _RESULT_MAX_CHARS, _is_internal_housekeeping,
)

import urllib.request

# ── Tuning constants ─────────────────────────────────────────────────────────

POLL_INTERVAL        = 60    # seconds between eval sweeps
HEARTBEAT_INTERVAL   = 300   # 5 min
PRE_EVAL_BATCH       = 10    # tasks scored per sweep
POST_EVAL_BATCH      = 5     # pending_eval tasks processed per sweep

# Where Sage parks a task that needs a human before it can be approved.
#
# Was 'review_needed' until 2026-08-17. That status is RETIRED — migration 118
# retired it in the readers, migration 121 retired it on the write side (a BEFORE
# trigger on task_queue now coerces it to pending_jeff_action and it is no longer in
# task_queue_status_check). Sage was the producer that kept it alive: these two
# branches were the only remaining writers in the lab, and because sage.py lived
# only under ~/claude-queue and was untracked, a repo grep for the producer found
# nothing for three occurrences running (migrations 035, 118, 121).
#
# Why review_needed rotted: nothing claims it (poll_queue claims ready/pending/
# delegated) and no sweeper moves it, so a row landed there was done-but-open
# forever — abb0f54f sat 24h with its engineering shipped, 846ff20e sat 105 days,
# both while the hourly task_queue_health digest delivered HTTP 204 about them.
# pending_jeff_action carries the same semantic and HAS readers: task_queue_health
# ('awaiting_jeff'), task_queue_attention, and the dashboard's JEFF_URGENT rank.
# It is also the lane Sage's own "result looks incomplete" branch already used.
REVIEW_GATE_STATUS = "pending_jeff_action"

# Safety scan: flag tasks matching any of these before dispatch
_DANGER_PATTERNS = [
    r"\brm\s+-rf\b",
    r"\bDROP\s+TABLE\b",
    r"\bDELETE\s+FROM\b(?!.*WHERE)",  # DELETE without WHERE
    r"\bFORMAT\s+[A-Z]:",             # Windows format
    r"\bchmod\s+777\b",
    r"\bdd\s+if=",
    r"\bshred\b",
    r"\btruncate\s+.*--size\s+0\b",
    r"push\s+--force\s+.*main",       # force push to main
    r"\bdrop\s+database\b",
    r"\bdestroy\b.*\bproduction\b",
]
_DANGER_RE = re.compile("|".join(_DANGER_PATTERNS), re.IGNORECASE)

# Result quality keywords — if a "completed" result mentions these, flag as incomplete
_INCOMPLETE_SIGNALS = [
    "not implemented", "todo", "placeholder", "left as an exercise",
    "would need to", "you'll need to", "unable to complete", "cannot complete",
    "encountered an error", "failed to", "could not", "timed out",
]

# Results that contain suggestions/recommendations need Jeff to review and act — don't auto-complete
_REVIEW_SIGNALS = [
    "recommend", "suggestion", "suggest", "consider", "you could", "you should",
    "i recommend", "i suggest", "proposed", "here are", "options:", "option 1",
    "next steps", "next step", "action items", "action item",
    "would you like", "let me know", "review the following", "please review",
    "for your review", "awaiting your", "waiting for your",
    "here is a plan", "here's a plan", "here is the plan", "proposed plan",
]

# Tasks touching deployable surfaces — UI, services, infra — must not auto-approve
# on agent self-report alone. Sage routes these to REVIEW_GATE_STATUS for manual verify
# unless the result includes explicit verification proof.
# Matched on word boundaries (not substrings) so e.g. "compose" does not fire
# on "pre-composed" — see 2026-07-05 false-gate on a Discord delivery task.
_DEPLOYABLE_SIGNALS = [
    "dashboard", "ui", "frontend", "front-end", "front end",
    "/api/", "api route", "api endpoint",
    "deploy", "deployed", "deployment",
    "container", "podman", "compose",
    "traefik", "router", "proxy",
    "systemd", "service", "service:",
    "next.js", "nextjs", "react",
    "schema", "migration", "database table",
    "rls policy", "supabase",
]


def _boundary_pattern(sig: str) -> re.Pattern:
    """Compile a signal into a regex that only matches whole words/phrases.
    Word boundaries are added only where the signal starts/ends with a word
    character, so punctuation-anchored signals like '/api/' still work."""
    pat = re.escape(sig)
    if sig[0].isalnum():
        pat = r"\b" + pat
    if sig[-1].isalnum():
        pat = pat + r"\b"
    return re.compile(pat)


_DEPLOYABLE_PATTERNS = [(sig, _boundary_pattern(sig)) for sig in _DEPLOYABLE_SIGNALS]
# If the result claims one of these, it's plausible the agent actually checked
_VERIFICATION_SIGNALS = [
    "curl ", "http 200", "http/200", "200 ok", "verified live", "verified in browser",
    "build succeeded", "build successful", "deploy succeeded", "deployment succeeded",
    "rollout complete", "service is up", "container healthy", "health check passed",
    "screenshot", "loaded successfully", "render confirmed", "tested in production",
    "git push", "merged into main", "merged to main", "live on home.az-lab",
    # Timer/script-class proof. The signals above are all HTTP/UI-shaped, so a
    # systemd-timer or CLI-script change could never satisfy the gate and looped
    # forever — see the git-durability audit task (2026-08-19 [2/4]), re-gated on
    # 08-21 despite a journal-backed run + three live probes. These are all
    # command-output-shaped (things you only quote if you ran the command),
    # not prose an agent would write while merely claiming success.
    "journalctl", "systemctl status", "systemctl --user", "list-timers",
    "result=success", "activestate=active", "substate=running",
    "exit code 0", "exited with 0", "needdaemonreload=no",
    "timer ran", "timer fired", "probe confirmed",
]

# Complexity thresholds for pre-dispatch tagging
_COMPLEX_WORD_COUNT = 150  # description word count above which = complex
_SPLIT_WORD_COUNT   = 400  # above this, suggest splitting


# ── Supabase helpers ─────────────────────────────────────────────────────────

# Consecutive failed heartbeat POSTs. A heartbeat that cannot leave the network
# is exactly what trips a `silent_agent` kill switch, and this used to be
# swallowed by a bare `except: pass` — so the gap left no trace in the journal
# and every incident had to be reconstructed from cloudflared/gluetun timings
# (2026-08-22 aardvark-dns flap, 2026-09-02 Cox WAN outage). Log the first
# failure and the recovery so the journal brackets the silence; stay quiet in
# between so a multi-hour outage does not flood it.
_hb_fail_streak = 0


def _write_heartbeat(status: str = "active", metadata: dict | None = None) -> None:
    global _hb_fail_streak
    try:
        payload = json.dumps({
            "agent": "sage",
            "status": status,
            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {"host": HOSTNAME},
        }).encode()
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
            print(f"[Sage] HEARTBEAT FAILED (1st consecutive) — {type(e).__name__}: {e}. "
                  f"Silence from here will look like a silent_agent anomaly; "
                  f"suspect network/WAN before suspecting Sage.", file=sys.stderr)
    else:
        if _hb_fail_streak:
            print(f"[Sage] HEARTBEAT RECOVERED after {_hb_fail_streak} "
                  f"consecutive failure(s).", file=sys.stderr)
            _hb_fail_streak = 0


def _patch_task(task_id: str, data: dict) -> None:
    api_request("PATCH", f"task_queue?id=eq.{task_id}", data=data)


def _add_tags(existing: list | None, *new_tags: str) -> list:
    tags = list(existing or [])
    for t in new_tags:
        if t not in tags:
            tags.append(t)
    return tags


# ── Safety scan ──────────────────────────────────────────────────────────────

def _is_dangerous(text: str) -> tuple[bool, str]:
    """Return (True, matched_snippet) if text matches danger patterns."""
    m = _DANGER_RE.search(text)
    if m:
        start = max(0, m.start() - 10)
        snippet = text[start: m.end() + 30].strip()
        return True, snippet
    return False, ""


# ── Pre-dispatch evaluation ──────────────────────────────────────────────────

def _score_complexity_local(task: dict) -> str:
    """Fast local heuristic: 'simple' | 'complex' | 'split'."""
    desc = task.get("description") or ""
    word_count = len(desc.split())
    priority = task.get("priority", 2)
    tags = [t.lower() for t in (task.get("tags") or [])]

    if priority == 0 or "complex" in tags or word_count >= _COMPLEX_WORD_COUNT:
        if word_count >= _SPLIT_WORD_COUNT and priority > 0:
            return "split"
        return "complex"
    return "simple"


def _score_complexity_nemotron(task: dict) -> str | None:
    """Ask Nemotron to classify task complexity. Returns 'simple'|'complex'|'split' or None."""
    key = _get_nvidia_key()
    if not key:
        return None
    title = task.get("title", "")
    desc = (task.get("description") or "")[:600]
    prompt = (
        "Classify this task's complexity for an AI coding agent. "
        "Reply with exactly one word: simple, complex, or split.\n"
        "- simple: can be done in one session under 30 minutes\n"
        "- complex: requires extended work (30min–2hr)\n"
        "- split: scope is too large for one session; should be broken into subtasks\n\n"
        f"Task: {title}\nDescription: {desc}"
    )
    body = json.dumps({
        "model": NEMOTRON_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 5,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        "https://integrate.api.nvidia.com/v1/chat/completions",
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
            for label in ("simple", "complex", "split"):
                if label in answer:
                    return label
    except Exception as e:
        print(f"[Sage] Nemotron complexity score failed (non-fatal): {e}", file=sys.stderr)
    return None


def pre_evaluate_pending(batch: int = PRE_EVAL_BATCH) -> int:
    """
    Find pending tasks that haven't been sage-evaluated yet.
    Tag with complexity and flag dangerous ones.
    Returns count of tasks processed.
    """
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "in.(pending,ready)",
            "target": "in.(claude-code,wren)",
            "order": "priority.asc,created_at.asc",
            "limit": str(batch),
            "select": "id,title,description,priority,tags,context",
        },
    )
    # Filter to tasks not yet sage-evaluated
    tasks = [t for t in (tasks or []) if "sage-evaluated" not in (t.get("tags") or [])]
    if not tasks:
        return 0

    count = 0
    for task in tasks:
        task_id = task["id"]
        title = task.get("title", task_id[:8])
        desc = task.get("description") or ""
        tags = list(task.get("tags") or [])

        new_tags = _add_tags(tags, "sage-evaluated")

        # Safety scan
        danger, danger_snippet = _is_dangerous(desc + " " + title)
        if danger:
            new_tags = _add_tags(new_tags, "safety-flagged")
            _patch_task(task_id, {
                "status": "pending_jeff_action",
                "tags": new_tags,
                "blocked_reason": f"Safety flag: `{danger_snippet[:150]}`",
            })
            log_activity("error", f"Safety flagged: {danger_snippet[:100]}", task_id=task_id)
            discord_notify(
                f"🛡️ **Safety flag — needs Jeff:** {title}\n"
                f"Blocked: `{danger_snippet[:120]}`"
            )
            count += 1
            continue

        # Complexity scoring (Nemotron first, local fallback)
        complexity = _score_complexity_nemotron(task) or _score_complexity_local(task)
        new_tags = _add_tags(new_tags, complexity)

        if complexity == "split":
            # Flag for Jeff to define subtasks (auto-split confidence too low for v1)
            new_tags = _add_tags(new_tags, "needs-split")
            _patch_task(task_id, {
                "status": "pending_jeff_action",
                "tags": new_tags,
                "blocked_reason": "Task scope too large for one session — please split into subtasks.",
            })
            log_activity("status", "Flagged for splitting", task_id=task_id)
            discord_notify(
                f"✂️ **Too large — needs split:** {title}\n"
                f"Please break this into smaller subtasks, then set back to `ready`."
            )
        else:
            # Just tag and leave in pending/ready
            _patch_task(task_id, {"tags": new_tags})
            print(f"[Sage] Pre-eval: {task_id[:8]} '{title}' → {complexity}")

        count += 1

    return count


# ── Post-execution evaluation ────────────────────────────────────────────────

def _result_looks_incomplete(result: str) -> tuple[bool, str]:
    if not result:
        return True, "empty result"
    lower = result.lower()
    for sig in _INCOMPLETE_SIGNALS:
        if sig in lower:
            idx = lower.index(sig)
            snippet = result[max(0, idx - 20): idx + len(sig) + 60].strip()
            return True, snippet
    return False, ""


def _result_needs_review(result: str) -> tuple[bool, str]:
    """Return (True, snippet) if result contains suggestions/plans that Jeff should act on."""
    if not result:
        return False, ""
    lower = result.lower()
    for sig in _REVIEW_SIGNALS:
        if sig in lower:
            idx = lower.index(sig)
            snippet = result[max(0, idx - 10): idx + len(sig) + 80].strip()
            return True, snippet
    return False, ""


def _strip_eval_boilerplate(result: str) -> str:
    """Drop Iris's eval-actions and Sage verify-gate boilerplate from the result
    before deploy-signal scanning. The boilerplate mentions words like 'supabase'
    and 'execute_sql' which would otherwise false-trigger the verify-gate on every
    completed task — including pure delivery tasks (Discord posts) that touch
    nothing deployable."""
    if not result:
        return result
    for marker in ("\n---\n**Iris", "\n---\n**Sage", "---\n**Iris", "---\n**Sage"):
        idx = result.find(marker)
        if idx >= 0:
            result = result[:idx]
    return result


def _is_deployable_change(task: dict, result: str) -> tuple[bool, str]:
    """Return (True, signal) when the task changes a deployable surface.
    Such tasks need explicit verification proof before auto-approval."""
    haystack = " ".join([
        task.get("title") or "",
        task.get("description") or "",
        _strip_eval_boilerplate(result) or "",
    ]).lower()
    tags = [t.lower() for t in (task.get("tags") or [])]
    if any(t in tags for t in ("dashboard", "ui", "deploy", "infrastructure", "service")):
        return True, "tag"
    for sig, pattern in _DEPLOYABLE_PATTERNS:
        if pattern.search(haystack):
            return True, sig.strip()
    return False, ""


def _has_verification_proof(result: str) -> bool:
    """True when the result text shows the agent actually verified the change is live.

    Boilerplate is stripped first for the same reason as in _is_deployable_change,
    but in the opposite direction: the verify-gate note itself contains the phrase
    'curl/HTTP 200', so scanning the raw result let a previously-gated task clear
    its own gate on the next pass purely on Sage's own words."""
    if not result:
        return False
    lower = (_strip_eval_boilerplate(result) or "").lower()
    return any(sig in lower for sig in _VERIFICATION_SIGNALS)


def post_evaluate_pending_eval(batch: int = POST_EVAL_BATCH) -> int:
    """
    Handle pending_eval tasks: assess result quality and either complete or escalate.
    Returns count processed.
    """
    tasks = api_request(
        "GET",
        "task_queue",
        params={
            "status": "eq.pending_eval",
            "order": "priority.asc,updated_at.asc",
            "limit": str(batch),
            "select": "id,title,result,priority,tags,goal_id,context",
        },
    )
    if not tasks:
        return 0

    count = 0
    for task in tasks:
        task_id = task["id"]
        title = task.get("title", task_id[:8])
        result = task.get("result") or ""
        goal_id = task.get("goal_id")

        # Housekeeping (transcript handoffs etc.) is agent-internal plumbing —
        # it must never route to Jeff, and closing it is invisible. Until
        # 2026-08-25 the verify-gate below stamped these pending_jeff_action
        # ("Process session transcript" → "Verify the dashboard change is live")
        # because the transcript happened to *mention* deployable work.
        # See feedback_empty_autogenerated_tasks_not_surfaced_to_jeff.
        if _is_internal_housekeeping(task):
            mark_completed(task_id, result, goal_id=goal_id)
            log_activity("status", "Sage: housekeeping auto-completed (never Jeff-gated)", task_id=task_id)
            count += 1
            continue

        incomplete, incomplete_reason = _result_looks_incomplete(result)
        needs_review, review_reason = _result_needs_review(result)
        deployable, deploy_signal = _is_deployable_change(task, result)
        has_proof = _has_verification_proof(result)

        if incomplete:
            mark_pending_jeff_action(
                task_id, result,
                f"Result appears incomplete: {incomplete_reason[:100]}",
                title=title, goal_id=goal_id,
            )
            log_activity("status", f"Sage: incomplete → Jeff ({incomplete_reason[:80]})", task_id=task_id)
        elif deployable and not has_proof:
            # UI/service/deploy work without verification proof — never auto-approve.
            # Force human verification before completion.
            stored = result[:_RESULT_MAX_CHARS] if result and len(result) > _RESULT_MAX_CHARS else result
            note = (
                f"\n\n---\n**Sage verify-gate:** result claims to change `{deploy_signal}` "
                f"but lacks explicit verification proof (curl/HTTP 200, build success, "
                f"live URL check, etc.). Confirm the change is actually live before approving."
            )
            sage_reason = f"Verify-gate: confirm `{deploy_signal}` change is actually live (no curl/build proof in result)"
            merged_ctx = dict(task.get("context") or {})
            merged_ctx["context_summary"] = sage_reason
            merged_ctx["action_required"] = f"Verify the {deploy_signal} change is live, then approve or send back."
            api_request("PATCH", f"task_queue?id=eq.{task_id}", data={
                "status": REVIEW_GATE_STATUS,
                "result": (stored or "") + note,
                "target": "jeff",
                "context": merged_ctx,
            })
            log_activity("status", f"Sage: verify-gate → {REVIEW_GATE_STATUS} ({deploy_signal})", task_id=task_id)
            discord_notify(
                f"🧪 **Verify before approve:** {title}\n"
                f"Touches `{deploy_signal}` — confirm it's actually live, not just claimed."
            )
            print(f"[Sage] Verify-gate: {task_id[:8]} '{title}' (signal: {deploy_signal})")
        elif needs_review:
            # Result has suggestions/plans/options — Jeff needs to review and decide
            stored = result[:_RESULT_MAX_CHARS] if result and len(result) > _RESULT_MAX_CHARS else result
            sage_reason = f"Review-gate: {review_reason[:140]}"
            merged_ctx = dict(task.get("context") or {})
            merged_ctx["context_summary"] = sage_reason
            merged_ctx["action_required"] = "Read the suggestions/plan in the result, then approve or redirect."
            api_request("PATCH", f"task_queue?id=eq.{task_id}", data={
                "status": REVIEW_GATE_STATUS,
                "result": stored,
                "target": "jeff",
                "context": merged_ctx,
            })
            summary = result.splitlines()[0][:100] if result else ""
            log_activity("status", f"Sage: suggestions detected → {REVIEW_GATE_STATUS} ({review_reason[:80]})", task_id=task_id)
            discord_notify(
                f"👀 **Review needed:** {title}\n"
                f"Result contains suggestions/plan — `{review_reason[:100]}`\n"
                f"Check task details and approve or redirect."
            )
            print(f"[Sage] Review needed: {task_id[:8]} '{title}'")
        else:
            from datetime import datetime, timezone as _tz
            stamp = datetime.now(_tz.utc).strftime("%Y-%m-%d %H:%M UTC")
            sage_note = f"\n\n---\n**Sage eval ({stamp}):** ✅ Approved — result complete, no deploy gate triggered, no unresolved suggestions."
            mark_completed(task_id, (result or "") + sage_note, goal_id=goal_id)
            summary = result.splitlines()[0][:100] if result else "done"
            discord_notify(f"✅ **Sage approved:** {title} — {summary}")
            log_activity("status", "Sage: result approved → completed", task_id=task_id)
            print(f"[Sage] Approved: {task_id[:8]} '{title}'")

        count += 1

    return count


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"[Sage] Starting on {HOSTNAME}")
    # Fail-loud auth probe — bail if Supabase key isn't valid so systemd marks
    # the service as failed instead of letting Sage silent-loop on 401s.
    try:
        from poll_queue import verify_supabase_auth
        verify_supabase_auth()
        print("[Sage] Supabase auth OK")
    except Exception as e:
        print(f"[Sage] STARTUP FAILED — Supabase auth probe: {e}", file=sys.stderr)
        try:
            discord_notify(f"❌ **Sage startup failed** on `{HOSTNAME}`: {e}")
        except Exception:
            pass
        sys.exit(2)
    discord_notify(f"🧙 **Sage online** on `{HOSTNAME}`")
    _write_heartbeat("starting")

    last_heartbeat = 0.0

    while True:
        try:
            now = time.time()

            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                _write_heartbeat()
                last_heartbeat = now

            # Pre-evaluate new pending tasks (tag complexity + safety)
            pre_count = pre_evaluate_pending()
            if pre_count:
                print(f"[Sage] Pre-evaluated {pre_count} task(s).")

            # Post-evaluate completed CRIT/HIGH tasks
            post_count = post_evaluate_pending_eval()
            if post_count:
                print(f"[Sage] Post-evaluated {post_count} pending_eval task(s).")

        except Exception as e:
            print(f"[Sage] Loop error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            _write_heartbeat("error", {"error": str(e)[:200]})

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
