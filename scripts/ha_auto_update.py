#!/usr/bin/env python3
"""
ha_auto_update.py — Nightly Home Assistant auto-update for the HAOS VM (192.168.1.161).

Runs on svc-podman-01 and drives Home Assistant over `ssh ha` (the HA CLI).

Flow:
  1. Pre-flight health check — refuse to update an instance that is already down.
  2. `ha refresh-updates` then read authoritative per-component state
     (supervisor / apps / core / os) rather than trusting a single summary call.
  3. Apply in dependency order: supervisor -> apps -> core -> OS.
     Core and app updates pass --backup so the Supervisor snapshots first.
  4. Reboot the host only when the OS was updated (core/app updates restart
     themselves; a reboot on top of them is pure extra downtime).
  5. Verify the site is back — poll the LAN endpoint and the Traefik hostname
     until both serve 200, then confirm core/apps are running.
  6. Report: Discord on change or failure, Supabase agent_activity always.

Exit code is non-zero if anything failed or the site did not come back.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

# ── Config ─────────────────────────────────────────────────────────────────────
SSH_TARGET      = "ha"
HEALTH_URLS     = [
    "http://192.168.1.161:8123/manifest.json",   # direct, bypasses Traefik
    "https://ha.az-lab.dev/manifest.json",       # through Traefik, what Jeff uses
]
AGENT_BUS_URL   = "http://localhost:8765"
AGENT_BUS_SECRET = os.environ.get("AGENT_BUS_SECRET", "")  # /discord/send is authed
DISK_FREE_WARN_GB = 10          # HA host free space floor worth flagging

SSH_TIMEOUT       = 60          # plain info/query calls
UPDATE_TIMEOUT    = 1800        # a single core/os/app update
REBOOT_WAIT       = 900         # how long to wait for the host after a reboot
HEALTH_WAIT       = 600         # how long to wait for the site after an update

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# The publishable key can read agent_activity but RLS rejects its inserts, so
# prefer the secret key and only fall back for read-only environments.
SUPABASE_KEY = (os.environ.get("SUPABASE_SECRET_KEY")
                or os.environ.get("SUPABASE_PUBLISHABLE_KEY", ""))

# HA REST API — HACS / custom-component updates the `ha` CLI cannot see.
HA_API_URL   = os.environ.get("HA_URL", "").rstrip("/")
HA_API_TOKEN = os.environ.get("HA_TOKEN", "")
# Update entities we must NOT drive over the API: core/OS/supervisor are handled
# by the CLI pass above (with backups and our own reboot handling), add-ons carry
# the BACKUP feature flag and are also CLI-managed, and device_class=firmware is
# real hardware (router, APs) that must never auto-flash unattended.
HA_SKIP_ENTITIES = {
    "update.home_assistant_core_update",
    "update.home_assistant_operating_system_update",
    "update.home_assistant_supervisor_update",
}
UPDATE_BACKUP_FEATURE  = 8      # UpdateEntityFeature.BACKUP -> supervisor-managed
ENTITY_INSTALL_TIMEOUT = 600

TAG = "[ha_auto_update]"


# ── Helpers ────────────────────────────────────────────────────────────────────

def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"{TAG} {ts} {msg}", flush=True)


def ha(args, timeout=SSH_TIMEOUT):
    """Run `ha <args>` on the HA host. Returns (returncode, stdout, stderr)."""
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=10",
        SSH_TARGET, "ha", *args,
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"


def ha_json(args, timeout=SSH_TIMEOUT):
    """Run a `ha ... --raw-json` call and return the `data` payload, or None."""
    rc, out, err = ha([*args, "--raw-json"], timeout=timeout)
    if rc != 0:
        log(f"WARN: `ha {' '.join(args)}` rc={rc}: {err or out}")
        return None
    try:
        return json.loads(out).get("data")
    except (ValueError, AttributeError) as e:
        log(f"WARN: could not parse JSON from `ha {' '.join(args)}`: {e}")
        return None


def ha_api(path, payload=None, timeout=30):
    """Call the HA REST API. Returns (ok, parsed_body_or_error_string)."""
    if not (HA_API_URL and HA_API_TOKEN):
        return False, "HA_URL/HA_TOKEN not set in environment"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        HA_API_URL + path, data=data,
        headers={"Authorization": "Bearer " + HA_API_TOKEN,
                 "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
        return True, (json.loads(body) if body.strip() else [])
    except Exception as e:
        return False, str(e)[:300]


def find_entity_updates():
    """HACS / custom-component updates, invisible to the Supervisor CLI.

    Returns [] when nothing is pending, or None if the API is unreachable, so a
    dead token is never mistaken for "everything is up to date".
    """
    ok, states = ha_api("/api/states")
    if not ok:
        log(f"WARN: HA REST API unreachable ({states}) - HACS updates not checked")
        return None
    out = []
    for s in states:
        eid = s.get("entity_id", "")
        if not eid.startswith("update.") or s.get("state") != "on":
            continue
        a = s.get("attributes", {}) or {}
        if eid in HA_SKIP_ENTITIES:
            continue
        if a.get("device_class") == "firmware":
            continue
        if (a.get("supported_features") or 0) & UPDATE_BACKUP_FEATURE:
            continue  # add-on: the CLI pass owns it
        name = (a.get("friendly_name") or eid)
        if name.endswith(" Update"):
            name = name[: -len(" Update")]
        out.append({"kind": "hacs", "entity_id": eid, "name": name,
                    "frm": a.get("installed_version"),
                    "to": a.get("latest_version")})
    return out


def http_ok(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ha-auto-update/1"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def site_up():
    """Every health endpoint must answer 200."""
    return all(http_ok(u) for u in HEALTH_URLS)


def wait_for_site(limit, what):
    """Poll until the site is serving again. Returns seconds waited, or None."""
    log(f"waiting for {what} (up to {limit}s)…")
    start = time.time()
    while time.time() - start < limit:
        if site_up():
            waited = round(time.time() - start)
            log(f"{what}: healthy after {waited}s")
            return waited
        time.sleep(10)
    log(f"ERROR: {what} did not come back within {limit}s")
    return None


def send_discord(msg):
    """agent-bus POST /message → #az-lab-infra. notify.send() chunks past 2000 chars."""
    try:
        payload = json.dumps({
            "text": msg,
            # "claude-code" is a misnomer that posts to the Cook Family
            # #admin-chat; infra alerts belong in #az-lab-infra.
            "channel": "infra",
            "username": "Wren · HA Updates",
        }).encode()
        req = urllib.request.Request(
            f"{AGENT_BUS_URL}/message",
            data=payload,
            headers={"Content-Type": "application/json",
                     "X-Agent-Secret": AGENT_BUS_SECRET},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.loads(r.read() or b"{}")
        if body.get("status") != "sent":
            print(f"{TAG} Discord send not confirmed: {body}", file=sys.stderr)
    except Exception as e:
        print(f"{TAG} Discord send failed: {e}", file=sys.stderr)


def log_supabase(content, metadata=None):
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        body = json.dumps({
            "agent": "wren",
            "activity_type": "status",
            "content": content,
            "metadata": metadata or {},
        }).encode()
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/agent_activity",
            data=body,
            headers={
                "Content-Type": "application/json",
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Prefer": "return=minimal",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"{TAG} Supabase log failed: {e}", file=sys.stderr)


# ── Update discovery ───────────────────────────────────────────────────────────

def find_updates():
    """Ask each component directly instead of trusting one summary endpoint."""
    pending = []

    sup = ha_json(["supervisor", "info"])
    if sup and sup.get("update_available"):
        pending.append({"kind": "supervisor", "name": "Supervisor",
                        "frm": sup.get("version"), "to": sup.get("version_latest")})

    apps = ha_json(["apps"])
    for a in (apps or {}).get("addons", []):
        if a.get("update_available"):
            pending.append({"kind": "app", "slug": a.get("slug"),
                            "name": a.get("name", a.get("slug")),
                            "frm": a.get("version"), "to": a.get("version_latest")})

    core = ha_json(["core", "info"])
    if core and core.get("update_available"):
        pending.append({"kind": "core", "name": "Core",
                        "frm": core.get("version"), "to": core.get("version_latest")})

    osi = ha_json(["os", "info"])
    if osi and osi.get("update_available"):
        pending.append({"kind": "os", "name": "Operating System",
                        "frm": osi.get("version"), "to": osi.get("version_latest")})

    entity_pending = find_entity_updates()
    if entity_pending:
        pending.extend(entity_pending)

    # If every probe failed we cannot tell "nothing pending" from "cannot reach".
    if sup is None and apps is None and core is None and osi is None:
        return None
    return pending


def apply_update(u):
    """Apply one update. Returns (ok, detail)."""
    kind = u["kind"]
    if kind == "hacs":
        log(f"applying hacs: {u['name']} {u.get('frm')} -> {u.get('to')}")
        ok, res = ha_api("/api/services/update/install",
                         {"entity_id": u["entity_id"]},
                         timeout=ENTITY_INSTALL_TIMEOUT)
        if not ok:
            log(f"FAILED hacs {u['name']}: {res}")
            return False, str(res)[:300]
        log(f"ok: {u['name']} now {u.get('to')}")
        return True, ""
    if kind == "supervisor":
        cmd = ["supervisor", "update"]
    elif kind == "app":
        cmd = ["apps", "update", u["slug"], "--backup"]
    elif kind == "core":
        cmd = ["core", "update", "--backup"]
    elif kind == "os":
        cmd = ["os", "update"]
    else:
        return False, f"unknown update kind {kind}"

    log(f"applying {kind}: {u['name']} {u.get('frm')} -> {u.get('to')}")
    rc, out, err = ha(cmd, timeout=UPDATE_TIMEOUT)
    if rc != 0:
        detail = (err or out or f"rc={rc}").splitlines()[-1][:300]
        log(f"FAILED {kind} {u['name']}: {detail}")
        return False, detail
    log(f"ok: {u['name']} now {u.get('to')}")
    return True, ""


def reboot_host():
    log("OS updated — rebooting host")
    # The reboot drops the SSH session, so a non-zero rc here is expected.
    ha(["host", "reboot"], timeout=60)
    time.sleep(45)  # let it actually go down before we start polling
    return wait_for_site(REBOOT_WAIT, "host reboot")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    started = datetime.now(timezone.utc)
    stamp = started.strftime("%Y-%m-%d %H:%M UTC")
    log(f"run start {stamp}")

    # 1. Pre-flight — never start surgery on a patient that is already down.
    if not site_up():
        log("pre-flight: site not healthy, waiting briefly in case of a blip")
        if wait_for_site(180, "pre-flight health") is None:
            msg = (f"🔴 **Home Assistant auto-update aborted** — {stamp}\n"
                   f"Pre-flight health check failed; HA was already unreachable. "
                   f"No updates were attempted.")
            send_discord(msg)
            log_supabase("HA auto-update aborted — pre-flight health check failed",
                         {"task": "ha-auto-update", "status": "aborted"})
            return 1

    # 2. Refresh version info, then discover what is actually pending.
    ha(["refresh-updates"], timeout=180)
    pending = find_updates()
    if pending is None:
        msg = (f"🔴 **Home Assistant auto-update aborted** — {stamp}\n"
               f"Could not query the Supervisor over `ssh ha`. No updates attempted.")
        send_discord(msg)
        log_supabase("HA auto-update aborted — supervisor unreachable over ssh",
                     {"task": "ha-auto-update", "status": "aborted"})
        return 1

    if not pending:
        log("nothing to update")
        log_supabase("HA auto-update — no updates available",
                     {"task": "ha-auto-update", "status": "noop"})
        return 0

    log(f"{len(pending)} update(s) pending: " +
        ", ".join(f"{u['name']} {u.get('frm')}->{u.get('to')}" for u in pending))

    # Snapshot which add-ons were running. core_ssh (for one) is deliberately
    # stopped, so only a *regression* from started -> not-started is worth an alert.
    was_started = {a.get("slug") for a in (ha_json(["apps"]) or {}).get("addons", [])
                   if a.get("state") == "started"}

    # 3. Apply in dependency order: supervisor, apps, core, OS.
    order = {"supervisor": 0, "app": 1, "core": 2, "os": 3, "hacs": 4}
    pending.sort(key=lambda u: order[u["kind"]])

    applied, failed, os_updated = [], [], False
    for u in pending:
        ok, detail = apply_update(u)
        if ok:
            applied.append(u)
            if u["kind"] == "os":
                os_updated = True
        else:
            failed.append((u, detail))
            # A failed core/supervisor update makes the rest meaningless.
            if u["kind"] in ("supervisor", "core"):
                log("stopping after a core/supervisor failure")
                break
        # Core and supervisor updates restart services — let them settle.
        if ok and u["kind"] in ("core", "supervisor"):
            wait_for_site(HEALTH_WAIT, f"{u['name']} restart")

    # 3b. HACS custom components only load on a Core restart. Skipped when an OS
    #     update is about to reboot the whole host anyway.
    if any(u["kind"] == "hacs" for u in applied) and not os_updated:
        log("restarting Core so updated custom components load")
        rc, out, err = ha(["core", "restart"], timeout=UPDATE_TIMEOUT)
        if rc != 0:
            detail = (err or out or f"rc={rc}").splitlines()[-1][:300]
            log(f"FAILED core restart: {detail}")
            failed.append(({"kind": "hacs", "name": "Core restart"}, detail))
        wait_for_site(HEALTH_WAIT, "core restart")

    # 4. Reboot only if the OS changed.
    reboot_ok = True
    if os_updated:
        reboot_ok = reboot_host() is not None

    # 5. Verify.
    healthy = site_up() or wait_for_site(HEALTH_WAIT, "final health check") is not None
    per_url = {u: http_ok(u) for u in HEALTH_URLS}

    versions, disk_free = {}, None
    if healthy:
        core = ha_json(["core", "info"]) or {}
        osi = ha_json(["os", "info"]) or {}
        sup = ha_json(["supervisor", "info"]) or {}
        host = ha_json(["host", "info"]) or {}
        versions = {"core": core.get("version"), "os": osi.get("version"),
                    "supervisor": sup.get("version")}
        disk_free = host.get("disk_free")
        stopped = [a.get("name") for a in (ha_json(["apps"]) or {}).get("addons", [])
                   if a.get("slug") in was_started and a.get("state") != "started"]
    else:
        stopped = []

    # 6. Report.
    dur = round((datetime.now(timezone.utc) - started).total_seconds() / 60, 1)
    applied_txt = ", ".join(f"{u['name']} → {u.get('to')}" for u in applied) or "none"
    lines = []
    if healthy and not failed and reboot_ok:
        lines.append(f"✅ **Home Assistant updated** — {stamp} ({dur} min)")
    else:
        lines.append(f"🔴 **Home Assistant update needs attention** — {stamp} ({dur} min)")
    lines.append(f"Applied: {applied_txt}")
    if failed:
        lines.append("Failed: " + "; ".join(f"{u['name']} ({d})" for u, d in failed))
    if os_updated:
        lines.append("Host rebooted: " + ("yes, came back" if reboot_ok else "**did not come back**"))
    lines.append("Site: " + ("up on both endpoints" if healthy else
                            "**DOWN** — " + ", ".join(f"{u}={'ok' if v else 'fail'}"
                                                      for u, v in per_url.items())))
    if versions:
        lines.append("Now: core {core}, OS {os}, supervisor {supervisor}".format(**versions))
    if stopped:
        lines.append("⚠️ Add-ons that stopped: " + ", ".join(stopped))
    if disk_free is not None and disk_free < DISK_FREE_WARN_GB:
        lines.append(f"⚠️ HA host free disk is {disk_free} GB — prune old backups.")
    if not healthy:
        lines.append("Restore: `ssh ha` → `ha backups` → `ha backups restore <slug>`")

    msg = "\n".join(lines)
    send_discord(msg)
    log_supabase(
        f"HA auto-update — applied: {applied_txt}; healthy={healthy}",
        {"task": "ha-auto-update",
         "status": "ok" if (healthy and not failed and reboot_ok) else "attention",
         "applied": [{"name": u["name"], "kind": u["kind"], "to": u.get("to")} for u in applied],
         "failed": [{"name": u["name"], "error": d} for u, d in failed],
         "rebooted": os_updated, "healthy": healthy, "versions": versions,
         "duration_min": dur},
    )
    print(msg)
    return 0 if (healthy and not failed and reboot_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
