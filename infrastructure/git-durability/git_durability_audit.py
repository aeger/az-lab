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

    AGE IS NOT THE ONLY AXIS (added 2026-08-19, third occurrence)
    The 08-19 run PRINTED `?? .../122_*.sql` and `?? .../123_*.sql` and then
    filtered both out of its own findings: they were 1.9d old and
    DIRTY_MAX_AGE_D is 3. Both were already APPLIED to production — the live
    schema's ground truth read migration_head_applied = 123. An applied
    migration is an irreversible schema change from minute zero, so the grace
    period that is correct for a half-written config file is, for this class,
    a three-day window in which the only copy of the DDL behind the running
    database sits on one disk, outside git and outside r2_backup (which
    excludes .git/objects). Same shape as 109 in v10.5. So severity is now a
    function of CLASS as well as age: an applied migration is a finding at
    age 0 and bypasses the age axis entirely. Everything else keeps it.

    The run also printed only its raw INPUT, which is why a reader could not
    tell whether a line had been considered and dismissed or never looked at.
    Every porcelain line now prints its DECISION and the reason for it.

WHAT IT REPORTS
    UNPUSHED           commits ahead of the remote, older than UNPUSHED_MAX_AGE_D
    DIRTY              tracked file modified and uncommitted for > DIRTY_MAX_AGE_D
    UNTRACKED          untracked path present for > DIRTY_MAX_AGE_D (not ignored)
    APPLIED_MIGRATION  a migration ALREADY APPLIED to prod is dirty/untracked —
                       reported at age 0, no grace period
    NO_UPSTREAM        branch has no remote-tracking ref — nothing to be ahead OF
    FETCH_FAILED       could not reach the remote, so the ahead-count is unproven

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
import os
import re
import subprocess
import sys
import importlib.util
import urllib.request
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

# ── the class that has no grace period ──────────────────────────────────────
# Repo -> repo-relative dirs whose NNN_*.sql files are covered by an applied-
# migration ledger we can actually query. Explicit, for the same reason REPOS
# is explicit: a glob for */migrations/* would sweep in vendored schema dirs
# whose apply-state we have no ledger for and could only guess at.
LEDGERED_MIGRATION_DIRS = {
    "azlab": ("services/memory-mcp-server/migrations/",),
}
MIGRATION_FILE_RE = re.compile(r"(\d{3})[^/]*\.sql$")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")

_NOTIFY = None
_HEAD = None  # (int|None, source_str) — the ledger is queried at most once/run


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


def git(repo: Path, *args, timeout=60, raw=False):
    """Run git and return (rc, stdout). stderr is surfaced on the journal only
    when it matters, so a routine 'not a git repository' does not read as noise.

    raw=True strips only the TRAILING newline. `git status --porcelain` encodes
    state in column 1, so a worktree-only modification is " M path" — and a
    blanket .strip() ate that leading space on the FIRST line only, shifting it
    left so line[3:] chopped a character off the path. The stat then failed and
    the line was dropped. Whichever dirty file sorted first was therefore
    unreportable, silently, since v1: the same class of bug as the one this
    whole script exists to catch, one layer down.
    """
    p = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, timeout=timeout,
    )
    out = p.stdout.rstrip("\n") if raw else p.stdout.strip()
    return p.returncode, out, p.stderr.strip()


def age_days(ts: float) -> float:
    return (datetime.now(timezone.utc).timestamp() - ts) / 86400.0


def applied_migration_head():
    """(head_number, human-readable source) from the LIVE schema's ledger.

    memory_state_ground_truth() reads supabase_migrations.schema_migrations,
    which is the database's own record of what it has actually run — the same
    ground truth staterefresh publishes. Deliberately NOT the highest file on
    disk: a file in the repo is not evidence the DB has it (076/077/078,
    2026-07-27), and here the whole question is which of those two it is.

    Returns (None, why) when the ledger cannot be reached. Callers must fail
    CLOSED on that: mistakenly flagging an unapplied migration costs one commit,
    while missing an applied one is the failure this class exists to catch.

    Caveat, stated rather than hidden: the ledger exposes a HEAD, not a set, so
    membership is inferred as seq <= head. Migrations apply in version order, so
    this is exact in every normal case; the one way it errs is an out-of-order
    apply (124 applied while 123 was skipped), where it over-reports 123. That
    direction is the safe one.
    """
    global _HEAD
    if _HEAD is not None:
        return _HEAD
    if not SUPABASE_KEY:
        _HEAD = (None, "SUPABASE_SECRET_KEY unset")
        return _HEAD
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/memory_state_ground_truth",
        data=b"{}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            gt = json.loads(r.read().decode())
        head = str(gt.get("migration_head_applied") or "")
        _HEAD = ((int(head[:3]), f"applied head {head}") if head[:3].isdigit()
                 else (None, f"ledger head unparseable: {head!r}"))
    except Exception as e:
        _HEAD = (None, f"ledger query failed: {e}")
    return _HEAD


def ledgered_migrations_under(repo: Path, name: str, path: str) -> list:
    """Every (relpath, seq) ledgered migration a porcelain line covers.

    git collapses a wholly-untracked directory into one `?? dir/` line, so an
    entry that IS a directory has to be expanded — otherwise an untracked
    migrations/ tree would classify as a single unremarkable directory.
    """
    prefixes = LEDGERED_MIGRATION_DIRS.get(name, ())
    if not prefixes:
        return []
    target = repo / path
    try:
        cand = ([str(p.relative_to(repo)) for p in sorted(target.rglob("*.sql"))]
                if target.is_dir() else [path])
    except OSError:
        return []
    out = []
    for c in cand:
        if any(c.startswith(pre) for pre in prefixes):
            m = MIGRATION_FILE_RE.search(c)
            if m:
                out.append((c, int(m.group(1))))
    return out


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
    rc, porcelain, _ = git(repo, "status", "--porcelain", raw=True)
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
            print(f"  -> FINDING   UNPUSHED — {age:.1f}d > UNPUSHED_MAX_AGE_D={UNPUSHED_MAX_AGE_D}d")
            findings.append({
                "kind": "UNPUSHED", "repo": name,
                "detail": f"{ahead} commit(s) ahead of origin/{branch}; "
                          f"oldest is {age:.1f}d old and exists only on this disk",
            })
        else:
            print(f"  -> ok        {age:.1f}d <= UNPUSHED_MAX_AGE_D={UNPUSHED_MAX_AGE_D}d")

    # ---- classify: CLASS first, then age. Every line records its decision ----
    decisions = []  # (code, path, verdict, why) — printed below, always
    for line in porcelain.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        kind = "UNTRACKED" if code.strip() == "??" else "DIRTY"
        try:
            age = age_days((repo / path).stat().st_mtime)
        except OSError:
            decisions.append((code, path, "skip", "cannot stat — deleted, or unreadable"))
            continue

        # CLASS AXIS. An applied migration has already changed the live schema,
        # irreversibly, so there is no age at which it is merely work-in-progress.
        promoted = False
        for mpath, seq in ledgered_migrations_under(repo, name, path):
            head, src = applied_migration_head()
            if head is None:
                why = (f"ledger UNAVAILABLE ({src}) — failing closed; an applied "
                       f"migration is unrecoverable, an unapplied one costs a commit")
            elif seq <= head:
                why = f"APPLIED to production ({src} >= {seq})"
            else:
                decisions.append((code, mpath, "age-axis",
                                  f"migration {seq} NOT applied ({src}) — ordinary age rule"))
                continue
            promoted = True
            decisions.append((code, mpath, "FINDING",
                              f"APPLIED_MIGRATION — {why}; age {age:.1f}d IGNORED "
                              f"(class bypasses DIRTY_MAX_AGE_D={DIRTY_MAX_AGE_D}d)"))
            findings.append({
                "kind": "APPLIED_MIGRATION", "repo": name,
                "detail": f"{mpath} — {kind.lower()} but {why}; {age:.1f}d old. The DDL "
                          f"behind the live schema exists only on this disk",
            })
        if promoted:
            continue

        # AGE AXIS, unchanged, for everything that is not that class.
        if age <= DIRTY_MAX_AGE_D:
            decisions.append((code, path, "ok",
                              f"{kind} {age:.1f}d <= DIRTY_MAX_AGE_D={DIRTY_MAX_AGE_D}d "
                              f"— work in progress, not a durability problem"))
            continue
        decisions.append((code, path, "FINDING",
                          f"{kind} — {age:.1f}d > DIRTY_MAX_AGE_D={DIRTY_MAX_AGE_D}d"))
        findings.append({
            "kind": kind, "repo": name,
            "detail": f"{path} — uncommitted for {age:.0f}d",
        })

    # Printing the raw input was the whole point of v1, but input alone cannot
    # tell a reader whether a line was considered and dismissed or never looked
    # at — which is exactly how 122/123 were printed and silently dropped. So
    # the DERIVATION prints too, every run.
    print("$ finding-set decision")
    for code, path, verdict, why in decisions or []:
        print(f"  [{code}] {verdict:<9} {path} — {why}")
    if not decisions:
        print("  (no porcelain lines to classify)")

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
        print(f"{f['kind']:<18} {f['repo']:<12} {f['detail']}")
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
