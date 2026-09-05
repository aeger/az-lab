#!/usr/bin/env python3
"""Podman healthcheck-integrity audit.

WHY THIS EXISTS
    On 2026-08-12 four containers on the retrieval path (az-tei-embed,
    az-tei-reranker, az-rerank-onnx, cadvisor-host) had sat in
    "Up 19-20 hours (starting)" since the 08-11 19:48Z reboot. podman inspect
    returned {"Status":"starting","FailingStreak":0,"Log":null} — the probe had
    never produced a single result, so FailingStreak could never leave 0 and
    nothing keying on `unhealthy` could ever fire. The services themselves were
    fine; the SCHEDULER was missing.

    Two distinct defects produce that state, and neither one raises anything:

      1. NO_TIMER — podman 4.9.3 only creates the per-container transient
         healthcheck timer when the healthcheck is passed on the podman command
         line (--health-cmd, or --healthcheck-command as podman-compose emits
         for a compose `healthcheck:` block). A healthcheck INHERITED FROM THE
         IMAGE populates .Config.Healthcheck but gets no timer at all. The
         status then freezes at whatever the container was born with, forever:
         cadvisor-host froze at `starting`, calibre-web-automated froze at a
         stale `healthy`. The frozen-healthy case is the dangerous one — it
         reads green on every dashboard while nothing is being probed.

      2. ORPHANED — the transient timers live in $XDG_RUNTIME_DIR and are named
         after the container ID. When a stack is recreated the old containers'
         timers can survive the containers, and then fire `podman healthcheck
         run <dead-id>` every interval forever, exiting 125 into the journal.

    Both are invisible to any check that only looks at Health.Status, because
    the whole failure mode is that Health.Status stops being written.

WHAT IT REPORTS
    NO_TIMER        healthcheck defined, no active timer -> status is frozen
    ORPHANED_TIMER  timer whose container no longer exists -> journal noise
    STUCK_STARTING  still `starting` well past start_period -> never converged
    UNHEALTHY       the ordinary case, included so this is one place to look
    STALE           running, but the last probe is older than it should be

    Findings are a FINDING, not a unit failure: the script always exits 0 so a
    degraded fleet does not also show up as a broken systemd unit (same
    convention as tier0-probe.service). Alerts post to Discord through the
    canonical agent-bus notifier and only on a CHANGE in the finding set, so a
    condition that persists for days does not repost every run.
"""

import json
import os
import re
import subprocess
import sys
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

NOTIFY_PY = Path.home() / "claude/agent-bus/notify.py"
STATE = Path.home() / ".wren-watchdog/container_health_audit.json"

# How far past start_period a container may still say `starting` before we call
# it stuck. start_period is already generous (600s for the ONNX reranker's
# first-start download+quantize); this is slack on top of that.
STARTING_GRACE_S = 300
# A probe result older than interval * this multiplier means the timer is not
# actually firing, whatever the recorded status says.
STALE_INTERVAL_MULT = 4
STALE_FLOOR_S = 300

_NOTIFY = None


def post(msg: str) -> None:
    """Route through the canonical agent-bus notifier (webhook-primary, bot +
    file-queue fallback) so we never drift from the rest of the system."""
    global _NOTIFY
    if _NOTIFY is None:
        try:
            spec = importlib.util.spec_from_file_location("notify", str(NOTIFY_PY))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _NOTIFY = mod
        except Exception as e:  # notifier missing/broken must not mask findings
            print(f"notify import failed: {e}", file=sys.stderr)
            _NOTIFY = False
    if _NOTIFY:
        try:
            _NOTIFY.send(msg)
            return
        except Exception as e:
            print(f"notify.send failed: {e}", file=sys.stderr)
    print("would have posted:", msg)


def runtime_dir() -> Path:
    return Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))


def podman_inspect_all() -> list[dict]:
    """One inspect call for every running container — per-container calls turn
    this into ~45 forks on a host this size."""
    ids = subprocess.run(
        ["podman", "ps", "-q"], capture_output=True, text=True, check=True
    ).stdout.split()
    if not ids:
        return []
    out = subprocess.run(
        ["podman", "inspect", *ids], capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


def active_timers() -> tuple[set[str], set[str]]:
    """Healthcheck timers systemd currently knows about, in both flavours.

    Returns (podman_transient_ids, explicit_container_names):
      - podman's own transient units, named after the 64-char container ID
      - our podman-healthcheck@<name>.timer fallback, named after the container

    Read from systemd rather than from the transient directory: a leftover unit
    FILE with no loaded unit would otherwise read as a healthy scheduler.
    """
    out = subprocess.run(
        ["systemctl", "--user", "list-units", "--type=timer", "--all",
         "--no-legend", "--plain", "--no-pager"],
        capture_output=True, text=True,
    ).stdout
    ids: set[str] = set()
    names: set[str] = set()
    for line in out.splitlines():
        parts = line.split()
        unit = parts[0] if parts else ""
        if not unit.endswith(".timer"):
            continue
        stem = unit[: -len(".timer")]
        if len(stem) == 64 and all(c in "0123456789abcdef" for c in stem):
            ids.add(stem)
        elif stem.startswith("podman-healthcheck@"):
            names.add(stem[len("podman-healthcheck@"):])
    return ids, names


def parse_ts(s: str):
    if not s:
        return None
    s = s.strip()
    if s.startswith("0001-01-01"):  # podman's zero value
        return None
    # podman emits RFC3339 with up to 9 fractional digits; fromisoformat on
    # 3.12 accepts Z but not >6 digits, so truncate the fraction to microseconds.
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$", s)
    if not m:
        return None
    base, frac, off = m.group(1), m.group(2) or "0", m.group(3) or "Z"
    off = "+00:00" if off == "Z" else off
    if len(off) == 5:  # +0000 -> +00:00
        off = f"{off[:3]}:{off[3:]}"
    try:
        return datetime.fromisoformat(f"{base}.{frac[:6]:0<6s}{off}")
    except ValueError:
        return None


def audit() -> list[dict]:
    now = datetime.now(timezone.utc)
    timers, timer_names = active_timers()
    containers = podman_inspect_all()
    live_ids = set()
    findings = []

    for c in containers:
        cid = c.get("Id", "")
        live_ids.add(cid)
        name = (c.get("Name") or cid[:12]).lstrip("/")
        hc = (c.get("Config") or {}).get("Healthcheck") or {}
        if not hc.get("Test"):
            continue  # no healthcheck declared: nothing to schedule, not a defect

        state = c.get("State") or {}
        health = state.get("Health") or state.get("Healthcheck") or {}
        status = health.get("Status") or "none"
        log = health.get("Log") or []

        interval_s = (hc.get("Interval") or 30_000_000_000) / 1e9
        start_period_s = (hc.get("StartPeriod") or 0) / 1e9
        started = parse_ts(state.get("StartedAt") or "")
        uptime_s = (now - started).total_seconds() if started else 0.0

        if cid not in timers and name not in timer_names:
            findings.append({
                "kind": "NO_TIMER", "container": name, "status": status,
                "detail": (f"healthcheck defined but no active timer -> status frozen "
                           f"at '{status}'; probes have run {len(log)} time(s)"),
            })
            continue  # the missing scheduler explains any status finding below

        if status == "unhealthy":
            findings.append({
                "kind": "UNHEALTHY", "container": name, "status": status,
                "detail": f"failing streak {health.get('FailingStreak')}",
            })
            continue

        if status == "starting" and uptime_s > start_period_s + STARTING_GRACE_S:
            findings.append({
                "kind": "STUCK_STARTING", "container": name, "status": status,
                "detail": (f"up {uptime_s/3600:.1f}h, start_period "
                           f"{start_period_s:.0f}s, {len(log)} probe result(s) — "
                           f"never converged, so `unhealthy` can never fire"),
            })
            continue

        last_end = parse_ts(log[-1].get("End", "")) if log else None
        threshold = max(interval_s * STALE_INTERVAL_MULT, STALE_FLOOR_S)
        if last_end and (now - last_end).total_seconds() > threshold:
            age = (now - last_end).total_seconds()
            findings.append({
                "kind": "STALE", "container": name, "status": status,
                "detail": (f"last probe {age/60:.0f}m ago (interval {interval_s:.0f}s) "
                           f"— reads '{status}' but is not being probed"),
            })

    for tid in sorted(timers - live_ids):
        findings.append({
            "kind": "ORPHANED_TIMER", "container": tid[:12], "status": "-",
            "detail": "timer for a container that no longer exists (exits 125 each interval)",
        })

    return findings


def main() -> int:
    try:
        findings = audit()
    except subprocess.CalledProcessError as e:
        print(f"podman call failed: {e}", file=sys.stderr)
        return 0  # a findings script must not become a second alert source

    key = sorted(f"{f['kind']}:{f['container']}" for f in findings)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    try:
        prev = json.loads(STATE.read_text()).get("key", [])
    except Exception:
        prev = []

    for f in findings:
        print(f"{f['kind']:<15} {f['container']:<28} {f['detail']}")
    if not findings:
        print("all container healthchecks are scheduled and reporting")

    if key != prev:
        if findings:
            lines = "\n".join(
                f"- **{f['kind']}** `{f['container']}` — {f['detail']}" for f in findings
            )
            post(f"⚠️ **Container healthcheck integrity** ({len(findings)} finding(s))\n{lines}")
        elif prev:
            post("✅ **Container healthcheck integrity** — all findings cleared.")
        STATE.write_text(json.dumps({
            "key": key, "at": datetime.now(timezone.utc).isoformat(), "findings": findings,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
