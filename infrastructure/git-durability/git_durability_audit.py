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

    ONE CLASS IS NOT THE PROPERTY (added 2026-08-21, fourth occurrence)
    The 08-19 fix was correct and enumerated exactly one class. The 08-21 run
    scored `[ M] ok services/memory-mcp-server/dreaming_consolidate.py — DIRTY
    0.4d <= DIRTY_MAX_AGE_D=3d — work in progress`. It was not work in progress.
    Those +159 lines (a new fetch_state_of_lab over goals, memory_conflicts and
    stale_memories_review_queue) were EXECUTED by
    memory-dreaming-consolidate.service at 02:15:16Z, thirty minutes after the
    edit, and last committed 864f572 on 2026-06-28. The consolidation they
    produced is downstream in Supabase; the source that produced it is on one
    disk, outside git, outside r2_backup.

    So the property the bypass encodes is not "is a migration" but "production
    has ALREADY EXECUTED this, irreversibly or unreproducibly". An applied
    migration is one member of that class. An ExecStart target that has run is
    another, and the age axis is as meaningless for it as for the migration:
    at 0.4d old it had already run once.

    ENABLED IS NOT THE SET THAT RUNS. Taking "every enabled unit" literally
    resolves 14 services on this box and misses dreaming_consolidate.py — the
    file that motivated this — because memory-dreaming-consolidate.service is
    `static`; only its .timer is enabled. Nearly every periodic job here is
    shaped that way, so an enabled .timer/.socket/.path is followed through
    Unit=/Triggers= to the service it actually starts: 57 services, 26 of them
    executing repo files. Stopping at `is-enabled` would have enumerated the
    wrong 14 and re-scored dreaming_consolidate.py ok, which is the bug.

WHAT IT REPORTS
    UNPUSHED           commits ahead of the remote, older than UNPUSHED_MAX_AGE_D
    DIRTY              tracked file modified and uncommitted for > DIRTY_MAX_AGE_D
    UNTRACKED          untracked path present for > DIRTY_MAX_AGE_D (not ignored)
    APPLIED_MIGRATION  a migration ALREADY APPLIED to prod is dirty/untracked —
                       reported at age 0, no grace period
    EXECUTING_UNCOMMITTED
                       a file systemd already RAN is dirty/untracked — reported
                       at age 0, no grace period
    NO_UPSTREAM        branch has no remote-tracking ref — nothing to be ahead OF
    FETCH_FAILED       could not reach the remote, so the ahead-count is unproven

    Any finding still present after ESCALATE_AFTER_RUNS consecutive runs is
    additionally queued to Supabase task_queue for wren, once per
    ESCALATE_COOLDOWN_D. See escalate().

    `git fetch` runs first. Without it the ahead-count is measured against a
    cached remote ref and can read 0 while the real remote is far behind — the
    same false-clean this script exists to prevent.

    Findings are a FINDING, not a unit failure: the script always exits 0, so a
    dirty tree does not also show up as a broken systemd unit (same convention
    as container_health_audit.py). Alerts post through the canonical agent-bus
    notifier and only on a CHANGE in the finding SET.

    A CORRECT FINDING NOBODY CONSUMES (added 2026-08-22, fifth occurrence)
    The first four fixes were all about the detector's ACCURACY — which lines it
    prints, which it promotes, which class bypasses the age axis. The 08-22 run
    got every one of those right and still changed nothing: it printed
    `UNTRACKED dashboard .claude/ -- uncommitted for 41d`, correctly, for the
    41st consecutive day. Inside was a 46M tree of live git worktrees plus a
    settings.local.json carrying the dashboard feeds API bearer token. Nobody
    had looked, because the output had become weather.

    Two defects, one shape. First, the dedup key was
    "{kind}:{repo}:{detail}" and detail carries the age, so the key changed
    every midnight and the "only alert on a CHANGE" contract above never held —
    it reposted to Discord daily, which is how a real finding trains its
    reader to ignore it. Identity is now the stable ident (kind, repo, path);
    age lives in the message, not the comparison.

    Second and larger: printing is not a consumer. A finding that recurs
    UNCHANGED across runs is itself evidence that no print will ever be acted
    on, so after ESCALATE_AFTER_RUNS it stops being a print and becomes a
    task_queue row that the poller picks up — two runs for the bypass classes,
    which never had a grace period, four for everything else. Escalation is
    idempotent against both the state file and an already-open task row, and
    re-fires after ESCALATE_COOLDOWN_D so that "escalated once, ignored
    forever" cannot rebuild this same failure one layer up.
"""

import json
import os
import re
import subprocess
import sys
import importlib.util
import urllib.parse
import urllib.request
import socket
from datetime import datetime, timezone
from pathlib import Path

NOTIFY_PY = Path.home() / "claude/agent-bus/notify.py"
STATE = Path.home() / ".wren-watchdog/git_durability_audit.json"
HOST = socket.gethostname()

# Repos whose only off-box copy is their git remote. Keep this list explicit
# rather than globbing for .git dirs: a scan would sweep up vendored checkouts
# and node_modules clones, whose dirtiness means nothing.
REPOS = [Path.home() / "azlab", Path.home() / "dashboard"]

# A same-day edit is normal work in progress, not a durability problem. These
# thresholds are about work that has been stranded long enough that a disk
# failure would actually lose something.
DIRTY_MAX_AGE_D = 3
UNPUSHED_MAX_AGE_D = 2

# ── how long a finding may go unactioned before it stops being a print ──────
# The timer runs every 6h, so these are counts of CONSECUTIVE runs in which the
# same ident was still present. Four runs is one full day of recurrence on top
# of whatever grace the age axis already granted; the two bypass classes get two
# runs because they had no grace period to begin with — production has already
# executed those bytes, so a day of thinking about it is a day too long.
ESCALATE_AFTER_RUNS = {
    "APPLIED_MIGRATION": 2,
    "EXECUTING_UNCOMMITTED": 2,
}
ESCALATE_AFTER_RUNS_DEFAULT = 4

# An escalation that fires once and is then permanently silent rebuilds the very
# failure this is fixing, one layer up. If the queued task is still not resolved
# after this long, escalate again rather than assume someone is on it.
ESCALATE_COOLDOWN_D = 14

# task_queue statuses that mean "this is already someone's problem" — an open
# row suppresses a duplicate even if the local state file was lost.
OPEN_TASK_STATUSES = (
    "backlog,ready,in_progress_agent,in_progress_jeff,pending_jeff_action,"
    "blocked,paused,pending,claimed,escalated,hand_back"
)

# ── the class that has no grace period ──────────────────────────────────────
# Repo -> repo-relative dirs whose NNN_*.sql files are covered by an applied-
# migration ledger we can actually query. Explicit, for the same reason REPOS
# is explicit: a glob for */migrations/* would sweep in vendored schema dirs
# whose apply-state we have no ledger for and could only guess at.
LEDGERED_MIGRATION_DIRS = {
    "azlab": ("services/memory-mcp-server/migrations/",),
}
MIGRATION_FILE_RE = re.compile(r"(\d{3})[^/]*\.sql$")

# ── the same bypass, generalised to what production already ran ─────────────
# ExecStart is read from systemd's RESOLVED view (`systemctl show`), not by
# parsing unit files: specifiers (%i, %h), drop-in overrides and Environment=
# expansion are systemd's job, and a hand-rolled parser of ~/.config/systemd
# would silently disagree with what actually executed. ExecStartPre/Post count
# too — a pre-hook that ran, ran.
EXEC_PROPS = ("ExecStart", "ExecStartPre", "ExecStartPost")
# `systemctl show` renders each Exec line as `{ path=... ; argv[]=a b c ; ... }`
# on ONE line. The argv is the whole command, so `python3 /path/script.py` puts
# the interesting file in a token, not in path=.
ARGV_RE = re.compile(r"argv\[\]=([^;}]*)")
UNIT_ID_RE = re.compile(r"^Id=(.+)$", re.M)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")

_NOTIFY = None
_HEAD = None  # (int|None, source_str) — the ledger is queried at most once/run
_EXEC_TARGETS = None  # {realpath: {unit}} — systemd is enumerated once/run


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


def _supabase(method: str, path: str, payload=None, timeout=15):
    """Minimal PostgREST call. Returns parsed JSON, or None on any failure —
    a queue that is unreachable must never mask or crash the audit itself."""
    if not SUPABASE_KEY:
        return None
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
            data=json.dumps(payload, default=str).encode() if payload is not None else None,
            headers={
                "Content-Type": "application/json",
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Prefer": "return=representation",
            },
            method=method,
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
        return json.loads(body) if body.strip() else []
    except Exception as e:
        print(f"task_queue {method} {path} failed: {e}", file=sys.stderr)
        return None


def escalate(f: dict, runs: int, threshold: int) -> bool:
    """Turn a finding that has recurred unchanged into a task_queue row.

    WHY THIS EXISTS
        On 2026-08-22 the dashboard repo's `?? .claude/` had been promoted to a
        FINDING on every run for 41 days. The detector was correct, its output
        was correct, and it was delivered to the journal and to Discord every
        single day. Nothing changed, because printing is not a consumer. A
        finding that recurs unchanged is evidence of exactly one thing — that
        nobody is going to act on it from a print — so at that point it has to
        become a row that somebody's poller picks up.

    Idempotent twice over: the caller stamps escalated_at so a live state file
    only fires once per cooldown, and an open task_queue row on the same stable
    title suppresses a duplicate even if that state file is deleted.
    """
    title = f"Git durability: {f['ident']} unresolved"
    existing = _supabase(
        "GET",
        f"task_queue?select=id,status&status=in.({OPEN_TASK_STATUSES})"
        f"&title=eq.{urllib.parse.quote(title, safe='')}",
    )
    if existing:
        print("  escalation SUPPRESSED — task_queue row already open: "
              f"{existing[0].get('id', '?')}")
        return True
    if existing is None:
        print("  escalation DEFERRED — task_queue unreachable; will retry next run")
        return False

    row = _supabase("POST", "task_queue", {
        "title": title,
        "description": (
            f"git-durability-audit has reported this finding unchanged for "
            f"{runs} consecutive runs (threshold {threshold}), and it is still "
            f"present:\n\n"
            f"    {f['kind']}  {f['repo']}  {f['detail']}\n\n"
            f"The detector is working; what is missing is a decision. Resolve the "
            f"CONTENT — commit it, .gitignore it, or push it — rather than "
            f"silencing the check. Look at what the path actually holds first.\n\n"
            f"    journalctl --user -u git-durability-audit.service -n 120\n"
            f"    git -C ~/{f['repo']} status --porcelain"
        ),
        "context": {
            "ident": f["ident"], "kind": f["kind"], "repo": f["repo"],
            "detail": f["detail"], "consecutive_runs": runs,
            "detector": "git-durability-audit.service", "host": HOST,
        },
        "priority": 0 if f["kind"] in ESCALATE_AFTER_RUNS else 1,
        "status": "ready",
        "source": "system",
        "target": "wren",
        "tags": ["git-durability", "audit", "auto-created", "escalated"],
    })
    if row is None:
        print("  escalation FAILED — task_queue insert rejected; will retry next run")
        return False
    print(f"  ESCALATED -> task_queue {row[0].get('id', '?') if row else '(created)'}")
    post(
        f"🔺 **Git durability — ESCALATED after {runs} runs**\n"
        f"- **{f['kind']}** `{f['repo']}` — {f['detail']}\n"
        f"Queued for wren; printing it daily was not making it go away."
    )
    return True


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


def _systemctl(*args, timeout=60):
    p = subprocess.run(
        ["systemctl", "--user", *args], capture_output=True, text=True, timeout=timeout,
    )
    return p.returncode, p.stdout


def execstart_targets() -> dict:
    """{absolute realpath: {unit, ...}} for every repo file systemd executes.

    Resolved once per run, and scoped to REPOS: an interpreter at /usr/bin/
    python3 is an argv token like any other, but it is not work that could be
    lost, and keeping it out makes the printed target set readable.

    Degrades to {} on any failure rather than raising. This is an ADDITIONAL
    promotion axis; if systemd cannot be enumerated, the age axis and the raw
    porcelain print — the parts this script exists for — must still run. Unlike
    the migration ledger there is no fail-closed option here: without a unit
    list there is no candidate set to fail closed ABOUT, so the loss is printed
    instead, and a reader sees that the class was not evaluated.
    """
    global _EXEC_TARGETS
    if _EXEC_TARGETS is not None:
        return _EXEC_TARGETS
    _EXEC_TARGETS = {}
    roots = []
    for r in REPOS:
        try:
            roots.append(r.resolve())
        except OSError:
            pass
    try:
        rc, out = _systemctl(
            "list-unit-files", "--state=enabled,enabled-runtime", "--no-legend",
        )
        if rc != 0:
            print("systemctl list-unit-files failed — EXECUTING_UNCOMMITTED not evaluated",
                  file=sys.stderr)
            return _EXEC_TARGETS

        # An enabled .timer/.socket/.path is a TRIGGER, not the thing that runs.
        # Follow it to its service or the whole class collapses to the handful
        # of units that happen to be enabled in their own right.
        services, seen = [], set()
        for ln in out.splitlines():
            parts = ln.split()
            if not parts:
                continue
            u = parts[0]
            if u.endswith(".service"):
                cand = [u]
            elif u.endswith((".timer", ".socket", ".path")):
                _, tv = _systemctl("show", u, "-p", "Unit", "-p", "Triggers", "--value")
                cand = [t for t in tv.split() if t.endswith(".service")]
            else:
                continue
            for c in cand:
                if c not in seen:
                    seen.add(c)
                    services.append(c)
        if not services:
            return _EXEC_TARGETS

        props = []
        for p in EXEC_PROPS:
            props += ["-p", p]
        rc, out = _systemctl("show", *services, "-p", "Id", *props, timeout=120)
        # Blocks are blank-line separated and each carries its own Id=, so a
        # unit with two ExecStart lines still attributes both correctly.
        for block in out.split("\n\n"):
            m = UNIT_ID_RE.search(block)
            if not m:
                continue
            unit = m.group(1).strip()
            for argv in ARGV_RE.findall(block):
                for tok in argv.split():
                    if not tok.startswith("/"):
                        continue
                    try:
                        rp = Path(tok).resolve()
                        if not rp.is_file():
                            continue
                    except OSError:
                        continue
                    if any(r == rp or r in rp.parents for r in roots):
                        _EXEC_TARGETS.setdefault(str(rp), set()).add(unit)
    except Exception as e:
        print(f"execstart enumeration failed: {e} — EXECUTING_UNCOMMITTED not evaluated",
              file=sys.stderr)
    return _EXEC_TARGETS


def is_execstart_target(repo: Path, path: str) -> list:
    """Every (relpath, [unit, ...]) ExecStart target a porcelain line covers.

    Same directory problem ledgered_migrations_under has: git collapses a
    wholly-untracked directory into one `?? dir/` line, so a dir entry is tested
    against every target BENEATH it rather than compared as a path. Both sides
    are realpaths, so a symlinked unit target still matches the file in the repo.
    """
    targets = execstart_targets()
    if not targets:
        return []
    try:
        root = repo.resolve()
        full = (repo / path).resolve()
        is_dir = full.is_dir()
    except OSError:
        return []
    hits = []
    for t, units in targets.items():
        tp = Path(t)
        if tp != full and not (is_dir and full in tp.parents):
            continue
        try:
            hits.append((str(tp.relative_to(root)), sorted(units)))
        except ValueError:
            continue
    return sorted(hits)


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
            "ident": f"FETCH_FAILED:{name}:origin/{branch}",
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
            "ident": f"NO_UPSTREAM:{name}:{branch}",
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
                "ident": f"UNPUSHED:{name}:{branch}",
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

        # CLASS AXIS. An applied migration has already changed the live schema;
        # a script systemd already ran has already had its effect somewhere
        # downstream. In both cases production consumed bytes that exist only on
        # this disk, so there is no age at which either is work-in-progress.
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
                "ident": f"APPLIED_MIGRATION:{name}:{mpath}",
                "detail": f"{mpath} — {kind.lower()} but {why}; {age:.1f}d old. The DDL "
                          f"behind the live schema exists only on this disk",
            })
        for tpath, units in is_execstart_target(repo, path):
            promoted = True
            # A dir line covers targets with their own mtimes; report the
            # target's, not the directory's.
            try:
                tage = age_days((repo / tpath).stat().st_mtime)
            except OSError:
                tage = age
            unit_s = ", ".join(units)
            decisions.append((code, tpath, "FINDING",
                              f"EXECUTING_UNCOMMITTED — ExecStart of {unit_s}; "
                              f"age {tage:.1f}d IGNORED (class bypasses "
                              f"DIRTY_MAX_AGE_D={DIRTY_MAX_AGE_D}d)"))
            findings.append({
                "kind": "EXECUTING_UNCOMMITTED", "repo": name,
                "ident": f"EXECUTING_UNCOMMITTED:{name}:{tpath}",
                "detail": f"{tpath} — {kind.lower()} and is ExecStart of {unit_s}; "
                          f"{tage:.1f}d old. Production is executing source that "
                          f"exists only on this disk",
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
            "ident": f"{kind}:{name}:{path}",
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
    # The bypass class's INPUT, printed for the same reason the porcelain is:
    # a promotion nobody can see the basis of is a claim, not a check. An empty
    # set here means the class was not evaluated, and says so.
    targets = execstart_targets()
    print("$ systemd ExecStart targets under audited repos")
    for t in sorted(targets):
        print(f"  {t} <- {', '.join(sorted(targets[t]))}")
    if not targets:
        print("  (none resolved — EXECUTING_UNCOMMITTED not evaluated this run)")

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

    # ── persistence, then escalation ────────────────────────────────────────
    # The v1 key was "{kind}:{repo}:{detail}", and detail carries the age
    # ("uncommitted for 41d"). That number ticks every day, so the key was never
    # equal to prev and the "only alert on a CHANGE" contract in the docstring
    # never actually held: `.claude/` reposted to Discord daily for 41 days.
    # Identity is now the ident — kind, repo, path — with age kept in the
    # message but out of the comparison.
    now = datetime.now(timezone.utc)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(STATE.read_text())
    except Exception:
        state = {}
    prev_seen = state.get("seen") or {}
    # v1 state had only "key", whose entries embed the age. They will not equal
    # any v2 ident, so on the single transition run a still-present finding
    # reposts once and a resolved one correctly posts the ✅ instead of being
    # swallowed as "nothing was outstanding".
    prev_idents = sorted(prev_seen) if prev_seen else sorted(state.get("key") or [])

    seen = {}
    for f in findings:
        was = prev_seen.get(f["ident"], {})
        seen[f["ident"]] = {
            "kind": f["kind"], "repo": f["repo"], "detail": f["detail"],
            "runs": int(was.get("runs", 0)) + 1,
            "first_seen": was.get("first_seen", now.isoformat()),
            "last_seen": now.isoformat(),
            "escalated_at": was.get("escalated_at"),
        }
    idents = sorted(seen)

    print("\n===== persistence =====")
    for ident in idents:
        e = seen[ident]
        thr = ESCALATE_AFTER_RUNS.get(e["kind"], ESCALATE_AFTER_RUNS_DEFAULT)
        esc = f", escalated {e['escalated_at']}" if e["escalated_at"] else ""
        print(f"  {ident} — run {e['runs']}/{thr} since {e['first_seen']}{esc}")
    if not idents:
        print("  (nothing outstanding)")

    # Alert on a change in the IDENT SET, which is what the docstring always
    # meant. A persisting condition now goes quiet here and loud in escalate().
    if idents != prev_idents:
        if findings:
            lines = "\n".join(
                f"- **{f['kind']}** `{f['repo']}` — {f['detail']}" for f in findings
            )
            post(f"⚠️ **Git durability** ({len(findings)} finding(s))\n{lines}")
        elif prev_idents:
            post("✅ **Git durability** — all repos pushed and clean.")

    for f in findings:
        e = seen[f["ident"]]
        thr = ESCALATE_AFTER_RUNS.get(f["kind"], ESCALATE_AFTER_RUNS_DEFAULT)
        if e["runs"] < thr:
            continue
        if e["escalated_at"]:
            try:
                since = (now - datetime.fromisoformat(e["escalated_at"])).days
            except Exception:
                since = 0
            if since < ESCALATE_COOLDOWN_D:
                continue
            print(f"  {f['ident']} — escalated {since}d ago and still open, re-escalating")
        if escalate(f, e["runs"], thr):
            e["escalated_at"] = now.isoformat()

    STATE.write_text(json.dumps({
        "seen": seen,
        "key": idents,   # retained for anything reading the old field
        "at": now.isoformat(),
        "findings": findings,
    }, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
