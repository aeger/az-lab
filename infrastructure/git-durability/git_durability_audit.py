#!/usr/bin/env python3
"""Git durability audit — is the work on this disk anywhere else?

WHY THIS EXISTS
    On 2026-08-17 the azlab repo was found 18 commits ahead of origin/beta,
    with the newest unpushed commit six days old. Migrations 114-120, the A-MAC
    fifth term, the episode reaper and the consult-capture view existed on
    exactly ONE disk. `git push --dry-run` succeeded — nothing had ever been
    blocking the push, it simply had not been run. Separately, five tracked
    files had been continuously modified-but-uncommitted for 24-36 days, two of
    them on the live hook path referenced from ~/.claude/settings.json.

    r2_backup.py:558 excludes .git/objects from the weekly-full tarball, so git
    history's only off-box copy is the GitHub remote. When the remote is six
    days stale, six days of work has no second copy at all.

    The reason this ran undetected is the part worth fixing. The daily research
    runs on 08-15 and 08-16 BOTH recorded "Working tree CLEAN". Every dirty
    file's mtime predates 08-15, so `git status --porcelain` would have returned
    the same five lines on both days. The check existed as a CLAIM in a report,
    never as a command whose output anyone saw.

    So the contract of this script is narrow and deliberate: it PRINTS the raw
    output of `git status --porcelain` and `git rev-list --count
    origin/<branch>..HEAD` on every run, unconditionally, clean or dirty. A
    reader (human or agent) sees the bytes git produced, not a summary of them.
    Anything else here — ageing, thresholds, Discord — is secondary to that.

WHAT IT REPORTS
    UNPUSHED        commits ahead of the remote, older than UNPUSHED_MAX_AGE_D
    DIRTY           tracked file modified and uncommitted for > DIRTY_MAX_AGE_D
    UNTRACKED       untracked path present for > DIRTY_MAX_AGE_D (not ignored)
    NO_UPSTREAM     branch has no remote-tracking ref — nothing to be ahead OF
    FETCH_FAILED    could not reach the remote, so the ahead-count is unproven

    `git fetch` runs first. Without it the ahead-count is measured against a
    cached remote ref and can read 0 while the real remote is far behind — the
    same false-clean this script exists to prevent.

    Findings are a FINDING, not a unit failure: the script always exits 0, so a
    dirty tree does not also show up as a broken systemd unit (same convention
    as container_health_audit.py). Alerts post through the canonical agent-bus
    notifier and only on a CHANGE in the finding set, so a condition that
    persists for days does not repost every run.
"""

import json
import subprocess
import sys
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

NOTIFY_PY = Path.home() / "claude/agent-bus/notify.py"
STATE = Path.home() / ".wren-watchdog/git_durability_audit.json"

# Repos whose only off-box copy is their git remote. Keep this list explicit
# rather than globbing for .git dirs: a scan would sweep up vendored checkouts
# and node_modules clones, whose dirtiness means nothing.
REPOS = [Path.home() / "azlab", Path.home() / "dashboard"]

# A same-day edit is normal work in progress, not a durability problem. These
# thresholds are about work that has been stranded long enough that a disk
# failure would actually lose something.
DIRTY_MAX_AGE_D = 3
UNPUSHED_MAX_AGE_D = 2

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


def git(repo: Path, *args, timeout=60):
    """Run git and return (rc, stdout). stderr is surfaced on the journal only
    when it matters, so a routine 'not a git repository' does not read as noise."""
    p = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, timeout=timeout,
    )
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def age_days(ts: float) -> float:
    return (datetime.now(timezone.utc).timestamp() - ts) / 86400.0


def audit_repo(repo: Path) -> list:
    """Audit one repo. PRINTS the raw git output first, then derives findings."""
    name = repo.name
    findings = []

    print(f"\n===== {repo} =====")
    if not (repo / ".git").exists():
        print("not a git repository — skipped")
        return findings

    rc, branch, _ = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if rc != 0:
        print("cannot resolve HEAD — skipped")
        return findings
    print(f"branch: {branch}")

    # Fetch BEFORE counting. A stale remote ref is exactly how an unpushed
    # backlog reads as zero.
    rc, _, err = git(repo, "fetch", "--quiet", "origin", branch, timeout=120)
    fetch_ok = rc == 0
    if not fetch_ok:
        print(f"git fetch FAILED: {err or 'unknown error'}")
        findings.append({
            "kind": "FETCH_FAILED", "repo": name,
            "detail": f"could not fetch origin/{branch}; ahead-count below is unproven",
        })

    # ---- the two commands whose absence caused this, printed verbatim ----
    rc, porcelain, _ = git(repo, "status", "--porcelain")
    print("$ git status --porcelain")
    print(porcelain if porcelain else "(empty — working tree clean)")

    upstream_rc, _, _ = git(repo, "rev-parse", "--verify", f"origin/{branch}")
    print(f"$ git rev-list --count origin/{branch}..HEAD")
    if upstream_rc != 0:
        print("(no such remote ref)")
        findings.append({
            "kind": "NO_UPSTREAM", "repo": name,
            "detail": f"branch {branch} has no origin/{branch} — work has no remote copy",
        })
        ahead = None
    else:
        _, ahead_s, _ = git(repo, "rev-list", "--count", f"origin/{branch}..HEAD")
        print(ahead_s)
        ahead = int(ahead_s or 0)
    # ---------------------------------------------------------------------

    if ahead:
        # Age of the OLDEST unpushed commit: that is how long the work has been
        # single-copy, which is the number that matters.
        _, oldest, _ = git(
            repo, "log", "--format=%ct", f"origin/{branch}..HEAD", "--reverse",
        )
        first = oldest.splitlines()[0] if oldest else None
        age = age_days(float(first)) if first else 0.0
        print(f"oldest unpushed commit: {age:.1f}d old")
        if age > UNPUSHED_MAX_AGE_D:
            findings.append({
                "kind": "UNPUSHED", "repo": name,
                "detail": f"{ahead} commit(s) ahead of origin/{branch}; "
                          f"oldest is {age:.1f}d old and exists only on this disk",
            })

    for line in porcelain.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        target = repo / path
        try:
            age = age_days(target.stat().st_mtime)
        except OSError:
            continue  # deleted, or a directory entry we cannot stat
        if age <= DIRTY_MAX_AGE_D:
            continue
        kind = "UNTRACKED" if code.strip() == "??" else "DIRTY"
        findings.append({
            "kind": kind, "repo": name,
            "detail": f"{path} — uncommitted for {age:.0f}d",
        })

    return findings


def main() -> int:
    findings = []
    for repo in REPOS:
        try:
            findings.extend(audit_repo(repo))
        except subprocess.TimeoutExpired:
            print(f"{repo}: git timed out", file=sys.stderr)
        except Exception as e:  # one bad repo must not hide the others
            print(f"{repo}: audit error: {e}", file=sys.stderr)

    print("\n===== findings =====")
    for f in findings:
        print(f"{f['kind']:<13} {f['repo']:<12} {f['detail']}")
    if not findings:
        print("all repos pushed and clean")

    key = sorted(f"{f['kind']}:{f['repo']}:{f['detail']}" for f in findings)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    try:
        prev = json.loads(STATE.read_text()).get("key", [])
    except Exception:
        prev = []

    if key != prev:
        if findings:
            lines = "\n".join(
                f"- **{f['kind']}** `{f['repo']}` — {f['detail']}" for f in findings
            )
            post(f"⚠️ **Git durability** ({len(findings)} finding(s))\n{lines}")
        elif prev:
            post("✅ **Git durability** — all repos pushed and clean.")
        STATE.write_text(json.dumps({
            "key": key, "at": datetime.now(timezone.utc).isoformat(), "findings": findings,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
