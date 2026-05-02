#!/usr/bin/env python3
"""scheduled_activity_seed.py — discovery + resync for the unified scheduler registry.

Walks every scheduler we know about and upserts a row in scheduled_activity:
  • systemd timers       (systemctl --user list-timers)
  • user crontab         (crontab -l)
  • CCR triggers         (claude.ai RemoteTrigger.list — opt-in via env)
  • agent loops          (hard-coded: sage, argus)
  • task_queue recurring (Supabase: WHERE recurring=true)

Designed to run idempotently. Safe to invoke from a systemd timer every
~15 min. Each call upserts current state via the upsert_scheduled_activity
RPC so the dashboard always reflects the live scheduler config.

Run-status updates (last_run_at, runs[]) are written by individual
schedulers calling record_scheduled_run as they fire — this script just
captures the existence + schedule + enabled state.

Requires migration 033 applied. Reads SUPABASE_SECRET_KEY from
~/azlab/services/memory-mcp-server/.env (fall through to env var).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://ogqjjlbupqnvlcyrfnxi.supabase.co"
ENV_FILE = Path.home() / "azlab/services/memory-mcp-server/.env"


def _load_secret() -> str:
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("SUPABASE_SECRET_KEY="):
                return line.split("=", 1)[1].strip()
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not key:
        sys.exit(
            "SUPABASE_SECRET_KEY not found in env or "
            f"{ENV_FILE} — cannot seed scheduled_activity."
        )
    return key


SUPABASE_KEY = _load_secret()


def log(*a: Any) -> None:
    print(f"[seed] {' '.join(str(x) for x in a)}", flush=True)


def rpc(name: str, params: dict) -> Any:
    body = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{name}",
        data=body,
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
        log(f"  [ERR] RPC {name} returned {e.code}: {body[:200]}")
        raise


def get(table: str, params: dict[str, str]) -> Any:
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{SUPABASE_URL}/rest/v1/{table}?{qs}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def upsert(
    *,
    name: str,
    kind: str,
    schedule: str,
    source_ref: dict,
    display_name: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    enabled: bool = True,
) -> str:
    """Returns the row id."""
    return rpc(
        "upsert_scheduled_activity",
        {
            "p_name": name,
            "p_kind": kind,
            "p_schedule": schedule,
            "p_source_ref": source_ref,
            "p_display_name": display_name,
            "p_description": description,
            "p_tags": tags or [],
            "p_enabled": enabled,
        },
    )


# ── 1. systemd timers ─────────────────────────────────────────────────────────


def systemd_timers() -> list[dict]:
    """Return list of {unit, schedule, enabled, next_at, last_at} for each user timer."""
    out = subprocess.run(
        ["systemctl", "--user", "list-timers", "--all", "--no-pager", "--no-legend"],
        check=True, capture_output=True, text=True,
    ).stdout

    rows: list[dict] = []
    for line in out.splitlines():
        # NEXT LEFT LAST PASSED UNIT ACTIVATES   (with embedded timestamps)
        # Easier: split off the trailing "<timer>.timer <service>.service" pair.
        line = line.strip()
        if not line:
            continue
        # split on whitespace from the right to grab UNIT + ACTIVATES first
        parts = line.rsplit(None, 2)
        if len(parts) < 3:
            continue
        unit = parts[-2]
        if not unit.endswith(".timer"):
            continue
        # Skip podman-internal user/auto-generated timers (hash names)
        if re.fullmatch(r"[0-9a-f]{50,}.timer", unit):
            continue
        rows.append({"unit": unit})

    # Enrich each with `systemctl --user cat` to extract OnCalendar / OnUnitActiveSec
    enriched: list[dict] = []
    for r in rows:
        try:
            txt = subprocess.run(
                ["systemctl", "--user", "cat", r["unit"]],
                check=True, capture_output=True, text=True,
            ).stdout
        except subprocess.CalledProcessError:
            continue

        on_cal = re.search(r"^OnCalendar\s*=\s*(.+)$", txt, re.M)
        on_act = re.search(r"^OnUnitActiveSec\s*=\s*(.+)$", txt, re.M)
        on_boot = re.search(r"^OnBootSec\s*=\s*(.+)$", txt, re.M)
        if on_cal:
            schedule = f"oncalendar:{on_cal.group(1).strip()}"
        elif on_act:
            schedule = f"every:{on_act.group(1).strip()}"
        elif on_boot:
            schedule = f"once-on-boot+{on_boot.group(1).strip()}"
        else:
            schedule = "unknown"

        # Description from [Unit] block, if present
        desc_m = re.search(r"^Description\s*=\s*(.+)$", txt, re.M)
        desc = desc_m.group(1).strip() if desc_m else None

        enriched.append(
            {
                "unit": r["unit"],
                "schedule": schedule,
                "description": desc,
            }
        )
    return enriched


def seed_systemd() -> int:
    count = 0
    for t in systemd_timers():
        unit = t["unit"]
        name = f"systemd-{unit.removesuffix('.timer')}"
        upsert(
            name=name,
            kind="systemd",
            schedule=t["schedule"],
            source_ref={"unit": unit},
            display_name=unit.removesuffix(".timer"),
            description=t.get("description"),
            tags=["systemd"],
        )
        count += 1
    log(f"systemd: upserted {count} timers")
    return count


# ── 2. user crontab ───────────────────────────────────────────────────────────


def seed_cron() -> int:
    try:
        out = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True
        ).stdout
    except FileNotFoundError:
        log("cron: crontab binary not found, skipping")
        return 0

    user = os.environ.get("USER", "almty1")
    count = 0
    for idx, line in enumerate(out.splitlines()):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Cron line: 5 fields then command
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        cron_expr = " ".join(parts[:5])
        cmd = parts[5]
        slug = re.sub(r"[^a-z0-9]+", "-", cmd.lower())[:40].strip("-")
        name = f"cron-{user}-{slug or f'line-{idx}'}"
        upsert(
            name=name,
            kind="cron",
            schedule=cron_expr,
            source_ref={"line": line, "user": user, "line_idx": idx},
            display_name=cmd[:80],
            description="user crontab entry",
            tags=["cron"],
        )
        count += 1
    log(f"cron: upserted {count} entries")
    return count


# ── 3. always-on agent loops ─────────────────────────────────────────────────
# Hard-coded since they're systemd Type=simple long-running processes that don't
# have a "schedule" per se — their poll interval is the schedule.

AGENT_LOOPS = [
    {
        "name": "agent-loop-sage",
        "service": "sage.service",
        "schedule": "loop:30s",
        "display_name": "Sage (task evaluator)",
        "description": "Always-on Python service polling task_queue for pending_eval and pre_eval work.",
    },
    {
        "name": "agent-loop-argus",
        "service": "argus.service",
        "schedule": "loop:30s",
        "display_name": "Argus (task orchestrator)",
        "description": "Always-on Python service spawning workers for ready tasks (max 3 parallel).",
    },
    {
        "name": "agent-loop-scheduled-control",
        "service": "scheduled-control.service",
        "schedule": "loop:30s",
        "display_name": "Scheduled Activity Control Daemon",
        "description": "Reconciles native scheduler state to match scheduled_activity registry every 30s. Phase 3 of unified scheduler.",
    },
    {
        "name": "agent-loop-watchdog",
        "service": "watchdog.service",
        "schedule": "loop:30s",
        "display_name": "Wren Watchdog",
        "description": "Always-on TS service monitoring Wren tmux liveness; sends canary on stale heartbeat.",
    },
]


def seed_agent_loops() -> int:
    count = 0
    for a in AGENT_LOOPS:
        # Verify service exists; skip if not loaded
        rc = subprocess.run(
            ["systemctl", "--user", "is-enabled", a["service"]],
            capture_output=True, text=True,
        ).returncode
        if rc not in (0, 1):  # 1 = disabled but loaded — still real
            continue
        upsert(
            name=a["name"],
            kind="agent_loop",
            schedule=a["schedule"],
            source_ref={"service": a["service"]},
            display_name=a["display_name"],
            description=a["description"],
            tags=["agent-loop"],
        )
        count += 1
    log(f"agent_loop: upserted {count} loops")
    return count


# ── 4. task_queue recurring rows ──────────────────────────────────────────────


def seed_task_queue_recurring() -> int:
    rows = get(
        "task_queue",
        {
            "recurring": "eq.true",
            "select": "id,recurring_key,title,description,context,last_run_at,run_count,runs",
        },
    )
    count = 0
    for r in rows:
        rk = r["recurring_key"] or r["id"]
        # Schedule lives in context.recurring_schedule for the legacy path,
        # otherwise we record "ccr-driven" as the source — the upstream CCR
        # trigger fires the upsert, no local schedule.
        ctx = r.get("context") or {}
        if isinstance(ctx, str):
            try:
                ctx = json.loads(ctx)
            except Exception:
                ctx = {}
        schedule = (ctx.get("recurring_schedule") or "ccr-driven").strip()
        upsert(
            name=f"recurring-{rk}",
            kind="task_queue_recurring",
            schedule=schedule,
            source_ref={"task_id": r["id"], "recurring_key": rk},
            display_name=r["title"],
            description=(r.get("description") or "")[:200] or None,
            tags=["task-queue", "recurring"],
        )
        count += 1
    log(f"task_queue_recurring: upserted {count} canonical rows")
    return count


# ── 5. CCR triggers (claude.ai) ───────────────────────────────────────────────
# Optional — requires CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_REMOTE_TOKEN. Skipped
# if no token. The control daemon (Phase 3) will handle live updates; this
# only seeds the registry from the current trigger config.

def seed_ccr_triggers() -> int:
    token = os.environ.get("CLAUDE_REMOTE_TOKEN") or os.environ.get(
        "CLAUDE_CODE_OAUTH_TOKEN"
    )
    if not token:
        log("ccr_trigger: no CLAUDE_REMOTE_TOKEN/CLAUDE_CODE_OAUTH_TOKEN set, skipping")
        return 0

    req = urllib.request.Request(
        "https://api.claude.ai/v1/code/triggers",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        log(f"ccr_trigger: list failed ({e}), skipping")
        return 0

    triggers = data.get("data", [])
    count = 0
    for t in triggers:
        if not t.get("enabled"):
            continue
        tid = t.get("id")
        name = t.get("name") or tid
        cron = t.get("cron_expression", "?")
        upsert(
            name=f"ccr-{name}",
            kind="ccr_trigger",
            schedule=cron,
            source_ref={"trigger_id": tid},
            display_name=name,
            description=t.get("description") or None,
            tags=["ccr", "claude.ai"],
            enabled=t.get("enabled", True),
        )
        count += 1
    log(f"ccr_trigger: upserted {count} triggers")
    return count


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    started = datetime.now(timezone.utc)
    log(f"=== seed start {started.isoformat()} ===")
    total = 0
    total += seed_systemd()
    total += seed_cron()
    total += seed_agent_loops()
    total += seed_task_queue_recurring()
    total += seed_ccr_triggers()
    log(f"=== seed done — {total} entries upserted ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
