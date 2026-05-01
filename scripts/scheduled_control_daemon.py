#!/usr/bin/env python3
"""scheduled_control_daemon.py — Phase 3 of the unified scheduler.

Reconciles native scheduler state against the scheduled_activity registry
every POLL_INTERVAL seconds. When the dashboard CRUD UI (Phase 4) writes
enabled/paused_at/schedule into the registry, this daemon reads the change
on the next tick and applies it to the native config:

  systemd:  systemctl --user enable/disable/start/stop + OnCalendar rewrite
            via /etc/systemd or ~/.config/systemd/user override drop-in
  cron:     crontab -l → edit/comment line → crontab -
  agent_loop: systemctl --user start/stop only (no schedule changes —
            the loop interval is compile-time)
  task_queue_recurring: UPDATE task_queue SET status='cancelled' (disable),
            schedule changes are upstream (Iris CCR), so warn-only
  ccr_trigger: warn-only — needs claude.ai trigger PAT, not the
            Supabase sbp_ token. Phase 5+.

Records every action in scheduled_activity_audit. Falls back gracefully
when a target is unreachable. Idempotent — re-running with no diff is
a no-op.

Runs as a systemd Type=simple service. Long-running. Polls. Logs to journal.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"
ENV_FILE = Path.home() / "azlab/services/memory-mcp-server/.env"
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
USER_SYSTEMD_DIR = Path.home() / ".config/systemd/user"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("scheduled-control")


def _load_secret() -> str:
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("SUPABASE_SECRET_KEY="):
                return line.split("=", 1)[1].strip()
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not key:
        log.error("SUPABASE_SECRET_KEY not found — daemon cannot start")
        sys.exit(2)
    return key


SUPABASE_KEY = _load_secret()


def rest_get(path: str) -> Any:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def rpc(name: str, params: dict) -> Any:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{name}",
        data=json.dumps(params).encode(),
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        log.error(f"RPC {name} failed: {e.code} {body[:200]}")
        raise


def insert_audit(activity_id: str, name: str, action: str, before: dict | None,
                 after: dict | None, notes: str | None = None) -> None:
    payload = {
        "scheduled_activity_id": activity_id,
        "scheduled_activity_name": name,
        "action": action,
        "actor": "control-daemon",
        "before": before,
        "after": after,
        "notes": notes,
    }
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/scheduled_activity_audit",
        data=json.dumps(payload).encode(),
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        log.warning(f"audit write failed for {name}/{action}: {e}")


# ── helpers ──────────────────────────────────────────────────────────────────


def run(cmd: list[str], check: bool = False) -> tuple[int, str, str]:
    """Run command, return (rc, stdout, stderr). Never raises unless check=True."""
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=check)
        return res.returncode, res.stdout, res.stderr
    except subprocess.CalledProcessError as e:
        return e.returncode, e.stdout or "", e.stderr or str(e)
    except subprocess.TimeoutExpired:
        return -1, "", f"timeout: {' '.join(cmd)}"


# ── systemd reconciliation ───────────────────────────────────────────────────


def systemd_is_enabled(unit: str) -> bool:
    rc, out, _ = run(["systemctl", "--user", "is-enabled", unit])
    return out.strip() == "enabled"


def systemd_is_active(unit: str) -> bool:
    rc, out, _ = run(["systemctl", "--user", "is-active", unit])
    return out.strip() in ("active", "activating")


def systemd_unit_path(unit: str) -> Path | None:
    """Return the user-managed path of the unit, or None if it's system-only."""
    p = USER_SYSTEMD_DIR / unit
    return p if p.exists() else None


SYSTEMD_DROPIN_FILE = "wren-override.conf"


def systemd_current_schedule(unit: str) -> str | None:
    """Return current native schedule string in the same encoding the registry uses."""
    rc, txt, _ = run(["systemctl", "--user", "cat", unit])
    if rc != 0:
        return None
    on_cal = re.search(r"^OnCalendar\s*=\s*(.+)$", txt, re.M)
    on_act = re.search(r"^OnUnitActiveSec\s*=\s*(.+)$", txt, re.M)
    if on_cal:
        return f"oncalendar:{on_cal.group(1).strip()}"
    if on_act:
        return f"every:{on_act.group(1).strip()}"
    return None


def systemd_write_dropin(unit: str, desired_schedule: str) -> tuple[bool, str]:
    """Write a drop-in override that sets OnCalendar / OnUnitActiveSec, then
    daemon-reload + restart the timer. Returns (ok, note).
    """
    if not unit.endswith(".timer"):
        return (False, "schedule edit only supported for .timer units")
    dropin_dir = USER_SYSTEMD_DIR / f"{unit}.d"
    dropin_path = dropin_dir / SYSTEMD_DROPIN_FILE

    # Decide which directive to set based on schedule prefix
    if desired_schedule.startswith("oncalendar:"):
        directive = "OnCalendar"
        value = desired_schedule[len("oncalendar:"):].strip()
        # Empty assignment first clears any inherited OnCalendar lines
        body = f"# Managed by scheduled_control_daemon — do not edit manually.\n[Timer]\nOnCalendar=\nOnCalendar={value}\n"
    elif desired_schedule.startswith("every:"):
        directive = "OnUnitActiveSec"
        value = desired_schedule[len("every:"):].strip()
        body = f"# Managed by scheduled_control_daemon — do not edit manually.\n[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec={value}\n"
    else:
        return (False, f"unsupported schedule format for systemd: {desired_schedule!r}")

    try:
        dropin_dir.mkdir(parents=True, exist_ok=True)
        dropin_path.write_text(body)
    except OSError as e:
        return (False, f"failed to write {dropin_path}: {e}")

    rc, _, err = run(["systemctl", "--user", "daemon-reload"])
    if rc != 0:
        return (False, f"daemon-reload failed: {err.strip()[:100]}")
    rc, _, err = run(["systemctl", "--user", "restart", unit])
    if rc != 0:
        return (False, f"restart {unit} failed: {err.strip()[:100]}")
    return (True, f"wrote drop-in {dropin_path.name}, set {directive}={value}")


def reconcile_systemd(row: dict) -> dict | None:
    """Return audit dict if any action taken, else None."""
    unit = row["source_ref"].get("unit")
    if not unit:
        return None

    desired_enabled = bool(row["enabled"])
    desired_running = desired_enabled and not row.get("paused_at")
    actual_enabled = systemd_is_enabled(unit)
    actual_running = systemd_is_active(unit)

    actions: list[str] = []
    notes: list[str] = []

    if desired_enabled != actual_enabled:
        verb = "enable" if desired_enabled else "disable"
        rc, _, err = run(["systemctl", "--user", verb, unit])
        actions.append(f"{verb}={'ok' if rc == 0 else 'fail'}")
        if rc != 0:
            notes.append(f"{verb} stderr: {err.strip()[:100]}")

    if desired_running != actual_running:
        verb = "start" if desired_running else "stop"
        rc, _, err = run(["systemctl", "--user", verb, unit])
        actions.append(f"{verb}={'ok' if rc == 0 else 'fail'}")
        if rc != 0:
            notes.append(f"{verb} stderr: {err.strip()[:100]}")

    # Phase 5.4 — reconcile schedule via drop-in override file. Only attempt
    # for .timer units the user owns and when the registry's schedule has the
    # expected prefix.
    if (unit.endswith(".timer")
            and (row["schedule"].startswith("oncalendar:")
                 or row["schedule"].startswith("every:"))):
        actual_schedule = systemd_current_schedule(unit)
        if actual_schedule and actual_schedule != row["schedule"]:
            ok, note = systemd_write_dropin(unit, row["schedule"])
            actions.append(f"schedule={'ok' if ok else 'fail'}")
            notes.append(note)

    if not actions and not notes:
        return None
    return {
        "actions": actions,
        "notes": "; ".join(notes) if notes else None,
        "before": {"enabled": actual_enabled, "running": actual_running},
        "after": {"enabled": desired_enabled, "running": desired_running, "schedule": row["schedule"]},
    }


# ── cron reconciliation ─────────────────────────────────────────────────────


def reconcile_cron(row: dict) -> dict | None:
    """Reconcile a cron entry: toggle enabled via DISABLED-BY-WREN marker AND
    apply schedule changes by replacing the 5-field cron expression on the
    matching line.

    source_ref.line holds the literal line text we matched at seed time. When
    the registry's `schedule` differs from the line's first 5 fields, we
    rewrite the line and update source_ref.line in the same call.
    """
    target_line = (row["source_ref"].get("line") or "").strip()
    if not target_line:
        return None

    rc, current, _ = run(["crontab", "-l"])
    if rc != 0:
        return None  # no crontab installed; nothing to do

    desired_active = bool(row["enabled"]) and not row.get("paused_at")
    desired_schedule = (row.get("schedule") or "").strip()
    disabled_marker = "# DISABLED-BY-WREN: "

    # Extract current 5-field cron expression from the target line
    parts = target_line.split(None, 5)
    if len(parts) < 6:
        return None
    current_expr = " ".join(parts[:5])
    cmd = parts[5]
    schedule_changed = (
        desired_schedule
        and desired_schedule != current_expr
        and not desired_schedule.startswith("oncalendar:")
        and not desired_schedule.startswith("every:")
        and not desired_schedule.startswith("loop:")
    )
    new_target_line = f"{desired_schedule} {cmd}" if schedule_changed else target_line

    new_lines: list[str] = []
    found_active = False
    found_disabled = False
    line_changed = False
    for ln in current.splitlines():
        ln_stripped = ln.strip()
        is_match_active = (ln_stripped == target_line)
        is_match_disabled = (
            ln.startswith(disabled_marker)
            and ln[len(disabled_marker):].strip() == target_line
        )
        if is_match_active:
            found_active = True
            base = new_target_line if schedule_changed else ln
            if desired_active:
                new_lines.append(base)
            else:
                new_lines.append(f"{disabled_marker}{base}")
            if base != ln:
                line_changed = True
        elif is_match_disabled:
            found_disabled = True
            inner = ln[len(disabled_marker):]
            base = new_target_line if schedule_changed else inner
            if desired_active:
                new_lines.append(base)  # restore (and possibly reschedule)
            else:
                new_lines.append(f"{disabled_marker}{base}")
            if base != inner:
                line_changed = True
        else:
            new_lines.append(ln)

    new_crontab = "\n".join(new_lines).rstrip() + "\n"
    if new_crontab == current.rstrip() + "\n":
        return None  # nothing to do

    proc = subprocess.run(
        ["crontab", "-"], input=new_crontab, text=True, capture_output=True, timeout=10
    )
    if proc.returncode != 0:
        return {
            "actions": ["crontab-write=fail"],
            "notes": f"stderr: {proc.stderr.strip()[:120]}",
            "before": {"enabled": found_active, "disabled_marker_present": found_disabled, "schedule": current_expr},
            "after":  {"enabled": desired_active, "schedule": desired_schedule if schedule_changed else current_expr},
        }

    # If we rewrote the line, update source_ref.line so future ticks match it.
    if schedule_changed:
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/scheduled_activity?id=eq.{row['id']}",
                data=json.dumps({
                    "source_ref": {**row["source_ref"], "line": new_target_line},
                }).encode(),
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                method="PATCH",
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as e:
            log.warning(f"source_ref.line update failed for {row['name']}: {e}")

    actions = ["crontab-write=ok"]
    if schedule_changed:
        actions.append("schedule=ok")
    note = f"toggled cron line: '{target_line[:60]}…'"
    if schedule_changed:
        note = f"changed schedule {current_expr!r} → {desired_schedule!r} on '{cmd[:50]}…'"

    return {
        "actions": actions,
        "notes": note,
        "before": {"enabled": found_active, "disabled_marker_present": found_disabled, "schedule": current_expr},
        "after":  {"enabled": desired_active, "schedule": desired_schedule if schedule_changed else current_expr,
                   "line_changed": line_changed},
    }


# ── agent_loop reconciliation ───────────────────────────────────────────────


def reconcile_agent_loop(row: dict) -> dict | None:
    service = row["source_ref"].get("service")
    if not service:
        return None
    return reconcile_systemd({
        **row,
        "source_ref": {"unit": service},
    })


# ── task_queue_recurring reconciliation ─────────────────────────────────────


def reconcile_task_queue_recurring(row: dict) -> dict | None:
    task_id = row["source_ref"].get("task_id")
    if not task_id:
        return None
    desired_active = bool(row["enabled"]) and not row.get("paused_at")
    desired_status = "ready" if desired_active else "cancelled"

    # Read current status
    cur = rest_get(f"task_queue?id=eq.{task_id}&select=status")
    if not cur:
        return None
    actual_status = cur[0]["status"]

    if desired_active and actual_status == "cancelled":
        target = "ready"
    elif not desired_active and actual_status not in ("cancelled", "completed", "archived"):
        target = "cancelled"
    else:
        return None  # already in sync

    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/task_queue?id=eq.{task_id}",
        data=json.dumps({"status": target}).encode(),
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="PATCH",
    )
    try:
        urllib.request.urlopen(req, timeout=8).read()
    except Exception as e:
        return {
            "actions": ["task_queue-patch=fail"],
            "notes": f"PATCH failed: {e}",
            "before": {"status": actual_status},
            "after":  {"status": target},
        }
    return {
        "actions": ["task_queue-patch=ok"],
        "before": {"status": actual_status},
        "after":  {"status": target},
    }


# ── dispatch ─────────────────────────────────────────────────────────────────

KIND_HANDLERS = {
    "systemd":              reconcile_systemd,
    "cron":                 reconcile_cron,
    "agent_loop":           reconcile_agent_loop,
    "task_queue_recurring": reconcile_task_queue_recurring,
    "ccr_trigger":          None,  # warn-only for now; requires claude.ai PAT
}


def reconcile_one(row: dict) -> None:
    handler = KIND_HANDLERS.get(row["kind"])
    name = row["name"]
    if handler is None:
        return
    try:
        result = handler(row)
    except Exception as e:
        log.exception(f"reconcile {name} threw")
        insert_audit(row["id"], name, "native_sync_failed", None, None, notes=str(e)[:300])
        return
    if result is None:
        return
    log.info(f"reconciled {name}: {'; '.join(result['actions'])}")
    insert_audit(
        row["id"], name,
        "native_sync_ok" if all("=ok" in a for a in result["actions"]) else "native_sync_partial",
        result.get("before"), result.get("after"), notes=result.get("notes"),
    )


def auto_unpause(rows: list[dict]) -> None:
    """Clear paused_at on rows whose unpause_at has elapsed.

    Phase 5.1 — supports the "pause for 30m/1h/4h" UI. Daemon runs this
    BEFORE the per-row reconciliation so the cleared pause propagates
    into the same tick.
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for row in rows:
        ua = row.get("unpause_at")
        if not ua or not row.get("paused_at"):
            continue
        try:
            ua_dt = datetime.fromisoformat(ua.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            continue
        if now < ua_dt:
            continue
        # Time's up — clear pause atomically
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/scheduled_activity?id=eq.{row['id']}",
                data=json.dumps({"paused_at": None, "unpause_at": None, "pause_reason": None}).encode(),
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                method="PATCH",
            )
            urllib.request.urlopen(req, timeout=8).read()
            log.info(f"auto-unpaused {row['name']} (unpause_at elapsed)")
            insert_audit(row["id"], row["name"], "auto_unpaused", None, None,
                         notes=f"unpause_at={ua} reached")
            # Reflect in our local copy so the immediate reconcile uses fresh state
            row["paused_at"] = None
            row["unpause_at"] = None
            row["pause_reason"] = None
        except Exception as e:
            log.warning(f"auto-unpause failed for {row['name']}: {e}")


def tick() -> None:
    rows = rest_get("scheduled_activity?select=id,name,kind,schedule,enabled,paused_at,unpause_at,pause_reason,source_ref&order=name")
    log.debug(f"tick: {len(rows)} rows")
    auto_unpause(rows)
    for row in rows:
        reconcile_one(row)


def main() -> int:
    log.info(f"scheduled-control daemon online — polling every {POLL_INTERVAL}s")
    while True:
        try:
            tick()
        except Exception as e:
            log.exception(f"tick failed: {e}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
