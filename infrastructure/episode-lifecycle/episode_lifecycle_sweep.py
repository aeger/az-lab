#!/usr/bin/env python3
"""agent_episodes lifecycle sweep — reap stranded episodes, surface the open count.

WHY THIS EXISTS
    On 2026-08-14, 109 of 287 agent_episodes rows (38%) were status='in_progress'
    with a NULL ended_at, the oldest open since 2026-05-24. agent_episodes is the
    trace primitive this lab has for "what did an agent actually do" — the thing
    OWASP's Top 10 for Agentic Applications 2026 calls observability under ASI06
    (trace IDs following a task across agents/tools, plus replay of recorded
    runs). A trace that never terminates is not a trace, and two separate pieces
    of work were blocked on it: the A-MAC outcome-utility term (which counts only
    status='completed') and the ASI06 layers 4-5 forensics gap.

    Nothing counted the open rows, so 38% of the table could sit open for three
    months without raising anything. That is the same shape as the frozen podman
    healthchecks (commit 34d6d8f): the failure mode is that the field which
    should be written stops being written, so a check keyed on the field's VALUE
    can never fire. It has to be keyed on the absence.

TWO CAUSES, TWO FIXES, THIS IS THE SECOND
    Migration 116 fixed the cause that had produced all 109: poll_queue.py wrote
    task_queue statuses ('pending_eval', 'pending_jeff_action') into an episode
    status column constrained to four values, so PostgREST rejected every such
    close-out 23514 and end_episode's best-effort except swallowed it.

    This sweep covers the class 116 cannot reach — the one where no close-out
    code runs at all. start_episode() opens the row over PostgREST
    (poll_queue.py:708) and nothing else owns it; if the poller is SIGKILLed, the
    host reboots mid-task, or run_claude's timeout takes the parent down, there
    is no PATCH to fix because there is no PATCH. 116's backfill is a one-shot
    UPDATE inside a migration. This makes the same predicate continuous.

WHAT IT DOES
    reap    calls reap_stale_episodes() (migration 117) — in_progress rows whose
            last activity is >6h old become 'abandoned' with the reason recorded.
            6h matches the window attach_episode_consults() trusts, so a stale
            row can never shadow that lookup.
    report  reads the agent_episode_health view and prints the distribution.
    alert   posts to Discord through the canonical agent-bus notifier, and only
            on a CHANGE in the alert key, so a steady state does not repost every
            hour. Always exits 0: a findings script must not also present as a
            broken systemd unit (same convention as container_health_audit.py and
            tier0-probe.service).
"""

import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path(
    os.environ.get("SUPABASE_ENV_FILE", Path.home() / "azlab/services/memory-mcp-server/.env")
)
NOTIFY_PY = Path.home() / "claude/agent-bus/notify.py"
STATE = Path.home() / ".wren-watchdog/episode_lifecycle_sweep.json"

# Episodes idle longer than this have no live run behind them. Measured over the
# 178 episodes that have ever reached ended_at: p50 1.4m, p90 7.2m, p99 24.8m,
# max 26.7m. Nothing has ever legitimately stayed open past 27 minutes, so 6h is
# ~14x p99 — and it is the same window attach_episode_consults() uses, which is
# the point: the reaper and that lookup agree by construction, not coincidence.
THRESHOLD = os.environ.get("EPISODE_STALE_THRESHOLD", "6 hours")

# Open episodes are normal — a task is usually running. This is the count above
# which "open" stops meaning "busy" and starts meaning "leaking". The poller runs
# one task at a time, so anything past a handful is already anomalous.
OPEN_ALERT_FLOOR = int(os.environ.get("EPISODE_OPEN_ALERT_FLOOR", "8"))

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


def creds() -> tuple[str, str]:
    url = key = ""
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("SUPABASE_URL="):
            url = line.split("=", 1)[1].strip()
        elif line.startswith("SUPABASE_SECRET_KEY="):
            key = line.split("=", 1)[1].strip()
    if not url or not key:
        raise RuntimeError(f"SUPABASE_URL / SUPABASE_SECRET_KEY missing from {ENV_FILE}")
    return url, key


def api(url: str, key: str, method: str, path: str, data=None):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read()
        return json.loads(body) if body else None


def main() -> int:
    try:
        url, key = creds()
        # Reap first, then read health, so the reported numbers describe the
        # state this run LEFT BEHIND rather than the one it found. open_stale in
        # the output is therefore the residue after reaping — it should be 0, and
        # a non-zero value means the reaper itself is not keeping up.
        reap = api(url, key, "POST", "rpc/reap_stale_episodes",
                   {"p_threshold": THRESHOLD, "p_dry_run": False})
        health = api(url, key, "GET", "agent_episode_health?select=*")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, RuntimeError) as e:
        detail = ""
        if isinstance(e, urllib.error.HTTPError):
            try:
                detail = f" — {e.read().decode()[:300]}"
            except Exception:
                pass
        print(f"episode sweep failed: {e}{detail}", file=sys.stderr)
        return 0  # never a second alert source

    row = (reap or [{}])[0] if isinstance(reap, list) else (reap or {})
    reaped = int(row.get("reaped") or 0)
    h = (health or [{}])[0] if isinstance(health, list) else (health or {})

    open_total = int(h.get("open_total") or 0)
    open_stale = int(h.get("open_stale") or 0)
    oldest_h = float(h.get("oldest_open_hours") or 0)
    ab_24h = int(h.get("abandoned_24h") or 0)
    total = int(h.get("episodes_total") or 0)
    frac = float(h.get("open_fraction") or 0)

    stamp = datetime.now(timezone.utc).strftime("%FT%TZ")
    print(
        f"[{stamp}] reaped={reaped} open={open_total} open_stale={open_stale} "
        f"oldest_open={oldest_h:.2f}h abandoned_24h={ab_24h} "
        f"episodes={total} open_fraction={frac:.4f}"
    )

    # (kind, text). The KIND is what the alert key is built from and is stable
    # across count changes; the text carries the numbers for the human reading it.
    findings = []
    if reaped:
        findings.append((
            "REAPED",
            f"reaped **{reaped}** stranded episode(s) → `abandoned` "
            f"(idle past {THRESHOLD}). No close-out ran for these — the run died "
            f"between start_episode() and end_episode().",
        ))
    if open_stale:
        findings.append((
            "STALE_AFTER_REAP",
            f"**{open_stale}** episode(s) still stale AFTER reaping — the reaper "
            f"is not keeping up, or something is re-opening rows.",
        ))
    if open_total > OPEN_ALERT_FLOOR:
        findings.append((
            "OPEN_ABOVE_FLOOR",
            f"**{open_total}** episodes open at once (floor {OPEN_ALERT_FLOOR}); "
            f"oldest {oldest_h:.1f}h. The poller runs one task at a time.",
        ))

    # The key is KINDS ONLY, plus the order of magnitude of the reap. A lab that
    # reaps one row an hour every hour should post once, not 24 times a day, and
    # an open count drifting 8->9->8 is not news. Deriving the key from the
    # message text instead would smuggle the counts back in and defeat this.
    mag = 0 if reaped == 0 else len(str(reaped))
    akey = sorted([k for k, _ in findings] + [f"mag{mag}"])

    STATE.parent.mkdir(parents=True, exist_ok=True)
    try:
        prev = json.loads(STATE.read_text()).get("key", [])
    except Exception:
        prev = []

    if akey != prev:
        if findings:
            post("⚠️ **Episode lifecycle** (agent_episodes)\n"
                 + "\n".join(f"- {t}" for _, t in findings)
                 + f"\n\n`open={open_total} stale={open_stale} "
                   f"abandoned_24h={ab_24h} of {total} episodes`")
        elif prev:
            post("✅ **Episode lifecycle** — no stranded episodes; every trace "
                 "is reaching a terminal status.")
        STATE.write_text(json.dumps({
            "key": akey, "at": stamp, "reaped": reaped, "health": h,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
