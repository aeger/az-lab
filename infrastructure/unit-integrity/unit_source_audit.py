#!/usr/bin/env python3
"""unit_source_audit.py — catch deployed-vs-repo drift in systemd user units.

WHY THIS EXISTS
    On 2026-08-16 claude-queue-poll.service was found to be running a file that
    was NOT the repo file:

        ExecStart=/usr/bin/python3 %h/claude-queue/poll_queue.py   (copy, Aug 14)
        ~/azlab/infrastructure/task-queue/poll_queue.py            (repo, Aug 15)

    The repo file had migration 118 applied (retire the `review_needed` task
    status). The running copy did not, so the poller kept handing Iris a prompt
    that instructed the retired status — and task f07163d0 was set to
    `review_needed` NINE MINUTES after 118 shipped. The fix was committed, the
    fix was never on the request path, and nothing anywhere noticed for a day.

    install.sh existed. It just had not been run. That is the whole failure
    mode, and it is silent by construction: a stale copy is a perfectly valid
    file that runs perfectly well.

WHAT IT CHECKS
    For every unit file in ~/.config/systemd/user:
      - the unit file itself, and
      - every existing file under $HOME named in its ExecStart argv
    are resolved and compared against their counterpart in ~/azlab.

    A path that resolves INTO the repo (symlink or direct ExecStart) is correct
    by construction and is not reported — that is the shape we want everything
    to converge on. A path that is an independent copy is compared by sha256.

WHAT IT REPORTS
    DRIFT       deployed copy differs from its repo source -> running stale code
    AMBIGUOUS   several repo files share that basename and none match -> the
                script cannot pick the source; add it to PIN below

    Files with no repo counterpart at all are NOT reported. Plenty of things
    here are legitimately host-local (argus.py, sage.py, the .bun shims), and a
    check that shouts about them gets muted, which is how you end up with no
    check at all.

    Findings are a FINDING, not a unit failure: always exits 0, and posts to
    Discord through the canonical agent-bus notifier only on a CHANGE in the
    finding set. Same conventions as container_health_audit.py, which shares
    this unit and timer.
"""

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
REPO = HOME / "azlab"
UNIT_DIR = HOME / ".config/systemd/user"
NOTIFY_PY = HOME / "claude/agent-bus/notify.py"
STATE = HOME / ".wren-watchdog/unit_source_audit.json"

# Directories under the repo that are runtime state, not source. Walking them is
# slow, permission-denied noisy, and would pollute the basename index with
# service config that happens to share a name with something deployed.
PRUNE = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "config", "data", "logs", "cache", ".cache",
}

# Explicit deployed -> repo pins, for the AMBIGUOUS cases only. Paths are
# relative to $HOME. Add here rather than renaming files to dodge the check.
PIN: dict[str, str] = {}

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


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def repo_index() -> dict[str, list[Path]]:
    """basename -> repo paths. One walk; PRUNE keeps it to source dirs."""
    idx: dict[str, list[Path]] = {}
    for root, dirs, files in os.walk(REPO, onerror=lambda e: None):
        dirs[:] = [d for d in dirs if d not in PRUNE and not d.startswith(".")]
        for f in files:
            idx.setdefault(f, []).append(Path(root) / f)
    return idx


def exec_paths(unit: str) -> list[Path]:
    """Existing files under $HOME named anywhere in the unit's ExecStart argv.

    Takes the whole argv rather than just argv[0] because the interesting target
    is usually the interpreter's argument (`/usr/bin/python3 <script>`), not the
    interpreter. Reads the resolved property so drop-in overrides are included.
    """
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show", "-p", "ExecStart", "--value", unit],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []

    found = []
    for argv in re.findall(r"argv\[\]=(.*?)\s*;", out):
        for tok in argv.split():
            p = Path(tok)
            if not p.is_absolute():
                continue
            try:
                if p.is_relative_to(HOME) and p.is_file():
                    found.append(p)
            except (OSError, ValueError):
                continue
    return found


def check(deployed: Path, idx: dict[str, list[Path]]) -> dict | None:
    """One deployed path against the repo. None = fine or not repo-managed."""
    try:
        real = deployed.resolve()
    except OSError:
        return None

    # Resolves into the repo: symlinked or run in place. Cannot drift.
    try:
        if real.is_relative_to(REPO):
            return None
    except ValueError:
        return None

    pinned = PIN.get(str(deployed.relative_to(HOME)) if deployed.is_relative_to(HOME) else "")
    candidates = [REPO / pinned] if pinned else idx.get(deployed.name, [])
    candidates = [c for c in candidates if c.is_file()]
    if not candidates:
        return None  # host-local, not repo-managed — deliberately silent

    try:
        mine = sha(real)
    except OSError:
        return None

    matched = [c for c in candidates if _safe_sha(c) == mine]
    if matched:
        return None  # identical to a repo source: correct content, weak linkage

    rel = str(deployed).replace(str(HOME), "~")
    if len(candidates) == 1:
        src = candidates[0]
        return {
            "kind": "DRIFT", "path": rel,
            "detail": (f"differs from repo source {str(src).replace(str(HOME), '~')} "
                       f"— the unit is running stale code; symlink it or re-run "
                       f"that component's install script"),
        }
    return {
        "kind": "AMBIGUOUS", "path": rel,
        "detail": (f"{len(candidates)} repo files named {deployed.name} and none "
                   f"match — add a PIN entry in unit_source_audit.py"),
    }


def _safe_sha(p: Path) -> str:
    try:
        return sha(p)
    except OSError:
        return ""


def audit() -> list[dict]:
    idx = repo_index()
    findings = []
    seen: set[Path] = set()

    for unit_file in sorted(UNIT_DIR.glob("*")):
        if unit_file.suffix not in (".service", ".timer") or not unit_file.is_file():
            continue  # skip .d drop-in dirs: those are legitimately host-local

        targets = [unit_file]
        if unit_file.suffix == ".service":
            targets += exec_paths(unit_file.name)

        for t in targets:
            if t in seen:
                continue
            seen.add(t)
            f = check(t, idx)
            if f:
                f["unit"] = unit_file.name
                findings.append(f)

    return findings


def main() -> int:
    try:
        findings = audit()
    except Exception as e:  # a findings script must not become a second alert source
        print(f"unit source audit failed: {e}", file=sys.stderr)
        return 0

    key = sorted(f"{f['kind']}:{f['path']}" for f in findings)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    try:
        prev = json.loads(STATE.read_text()).get("key", [])
    except Exception:
        prev = []

    for f in findings:
        print(f"{f['kind']:<10} {f['unit']:<38} {f['path']} — {f['detail']}")
    if not findings:
        print("all repo-managed unit sources match the repo")

    if key != prev:
        if findings:
            lines = "\n".join(
                f"- **{f['kind']}** `{f['path']}` ({f['unit']}) — {f['detail']}"
                for f in findings
            )
            post(f"⚠️ **Unit source integrity** ({len(findings)} finding(s))\n{lines}")
        elif prev:
            post("✅ **Unit source integrity** — all findings cleared.")
        STATE.write_text(json.dumps({
            "key": key, "at": datetime.now(timezone.utc).isoformat(),
            "findings": findings,
        }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
