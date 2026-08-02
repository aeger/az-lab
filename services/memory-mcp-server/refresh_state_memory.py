#!/usr/bin/env python3
"""
Refresh the auto-generated ground-truth block in the memories row
name='memory-mcp-server'. REC 3 from the 2026-08-02 daily self-improvement
research (TIER 3).

WHY THIS EXISTS
    That row is the most-recalled state record in the corpus (access_count 174)
    and it seeds every daily-research run. On 2026-08-02 it asserted migration
    head 093 and 79 eval probes; disk said 096 and the DB said 100. Every agent
    that recalled it started from a day-stale picture, and the research task
    spent four verification steps every morning rediscovering the same numbers.

    The task definition already warned that any hardcoded feature list "WILL lag
    production." The fix is not to write the list more carefully — it is to stop
    hand-maintaining the parts that are mechanically derivable.

WHAT IT TOUCHES
    ONLY the text between the two AUTO-GENERATED markers. Everything a human
    wrote — the gotchas, the corrections, the reasoning about why 086 landed the
    way it did — is preserved byte for byte. If the markers are absent the block
    is prepended, so the generated summary is the first thing a reader sees
    before the historical prose.

IDEMPOTENCE
    If the freshly rendered block is identical to the one already stored, the
    script writes NOTHING. That matters: a content UPDATE bumps updated_at, fires
    the entity/fact extractors, and would need a re-embed. Skipping the no-op
    keeps a nightly job from churning the row 365 times a year for nothing.

RE-EMBEDDING
    When the block DOES change, embedding is set to NULL so
    startEmbeddingBackfillJob() (every 30 min, 25 rows) re-embeds it. Direct SQL
    writes bypass the remember() tool and would otherwise leave a stale vector
    attached to changed content — the same silent-drift failure the 2026-07-15
    Ollama wedge caused.

Usage:
    python3 refresh_state_memory.py [--dry-run]

Wired into eval/nightly_eval.sh, which runs after every other governance timer.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
HEALTH_URL = os.environ.get("MEMORY_HEALTH_URL", "http://localhost:3100/health")

SCRIPT_DIR = Path(__file__).resolve().parent
MIGRATIONS_DIR = SCRIPT_DIR / "migrations"
STATE_MEMORY_NAME = "memory-mcp-server"

# Plain-text markers, deliberately NOT HTML comments: the scan_memory_for_injection()
# trigger carries a `hidden_html_directive` soft pattern that matches
# <!-- ... (instruction|prompt|ignore|system) ... -->, and a generated block is
# exactly the kind of thing that drifts into tripping it. Quarantining the most-
# recalled record in the corpus as a side effect of a cosmetic marker choice is a
# bad trade for prettier syntax.
BEGIN_MARK = "=== AUTO-GENERATED GROUND TRUTH (memory-eval-nightly) — BEGIN ==="
END_MARK = "=== AUTO-GENERATED GROUND TRUTH — END ==="

logging.basicConfig(level=logging.INFO, format="%(asctime)s [staterefresh] %(message)s")
log = logging.getLogger("staterefresh")


def sb_headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def disk_migration_head():
    """Highest NNN_*.sql on disk. Reported alongside the applied head, never instead
    of it — a file in the repo is not evidence the DB has it (076/077/078, 2026-07-27)."""
    heads = sorted(
        p.name for p in MIGRATIONS_DIR.glob("*.sql") if p.name[:3].isdigit()
    )
    return heads[-1] if heads else "unknown"


def service_health(client):
    try:
        r = client.get(HEALTH_URL, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        # A wedged container must not silently become "no version reported" —
        # say so in the block, where an agent reading the memory will see it.
        log.error("health probe failed: %s", e)
        return {"status": "UNREACHABLE", "error": str(e)}


def ground_truth(client):
    r = client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/memory_state_ground_truth",
        json={},
        headers=sb_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def git_sha():
    try:
        return subprocess.check_output(
            ["git", "-C", str(SCRIPT_DIR), "rev-parse", "--short", "HEAD"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return "unknown"


def render_block(health, gt, disk_head):
    def pct(d):
        return " / ".join(f"{k} {v}" for k, v in sorted(d.items()))

    corpus = gt["corpus"]
    ev = gt["eval"]
    run = gt.get("latest_eval_run") or {}
    inj = gt["injection_scan"]
    con = gt["conflicts"]
    sk = gt["skills"]

    applied = gt["migration_head_applied"]
    disk_stem = disk_head.rsplit(".sql", 1)[0]
    head_line = f"**Migration head:** applied `{applied}` · on disk `{disk_stem}`"
    # Both directions of divergence are real failures, with opposite causes, so
    # name which one it is rather than emitting a generic "DIVERGED".
    def head_num(s):
        return int(s[:3]) if s[:3].isdigit() else -1
    a, d = head_num(applied), head_num(disk_stem)
    if d > a:
        head_line += ("  ⚠️ **DISK AHEAD — migration file(s) in the repo are NOT applied. "
                      "A file in the repo is not proof the DB has it (cf. 076/077/078, 2026-07-27).**")
    elif a > d:
        head_line += ("  ⚠️ **DB AHEAD — migration(s) applied with no file committed. "
                      "That is the 093 data-loss shape: live SQL existing in no git object and no backup.**")

    tiers = ev.get("by_tier") or {}
    tier_str = " / ".join(f"{k} {v}" for k, v in sorted(tiers.items()))

    def num(key, fmt="{:.4f}"):
        v = run.get(key)
        return fmt.format(v) if isinstance(v, (int, float)) else "n/a"

    lines = [
        BEGIN_MARK,
        "Rewritten nightly by refresh_state_memory.py (via memory-eval-nightly.service).",
        "Do not hand-edit inside these markers — edits are overwritten. Everything",
        "outside them is human-authored and preserved.",
        "",
        f"**Generated:** {gt['generated_at']} · repo sha `{git_sha()}`",
        f"**Service:** v{health.get('version','?')} · {health.get('tools','?')} tools · status `{health.get('status','?')}`"
        + (f" · r2={health.get('r2')} ha={health.get('ha')} aip={health.get('aip')}" if health.get("status") == "ok" else ""),
        head_line + f" · {gt['migrations_applied_count']} applied total",
        "",
        f"**Corpus:** {corpus['total']} memories · {corpus['active']} active / {corpus['inactive']} inactive · "
        f"{corpus['retired']} retired · {corpus['missing_embedding']} missing embeddings · "
        f"{corpus['conflict_flagged']} conflict_flagged · {corpus['staleness_candidate']} staleness_candidate",
        f"**Trust tiers:** {pct(gt['trust_tiers'])}",
        f"**Conflicts:** {con['open']} open / {con['total']} total",
        f"**Skills:** {sk['total']} · {sk['with_outcome_data']} carrying outcome data",
        "",
        f"**Eval:** {ev['active_probes']} active probes — {tier_str} · {ev['with_forbidden']} with forbidden_memory_ids",
        f"**Last run** `{run.get('tag','n/a')}` (sha `{run.get('git_sha','?')}`, scoreset v{run.get('scoreset_version','?')}, "
        f"n={run.get('n_queries','?')}, {run.get('created_at','?')}):",
        f"  recall@1 {num('recall_at_1')} · recall@5 {num('recall_at_5')} · nDCG@5 {num('ndcg_at_5')} · "
        f"nDCG@10 {num('ndcg_at_10')} · MRR {num('mrr')}",
        f"  hard tier n={run.get('n_hard','?')} recall@5 {num('hard_recall_at_5')} nDCG@10 {num('hard_ndcg_at_10')} · "
        f"abstention n={run.get('n_abstention','?')} rate {num('abstention_rate')} · fcfr_scorable {num('fcfr_scorable')}",
        "",
        f"**Injection scan (OWASP ASI06 point 4):** pattern version {inj.get('pattern_version')} · "
        f"{inj.get('scanned_active')} active rows scanned, {inj.get('never_scanned_active')} never scanned · "
        f"last {inj.get('last_scan_at')}",
        f"  findings: {inj.get('findings_pending')} pending / {inj.get('findings_confirmed')} confirmed / "
        f"{inj.get('findings_accepted_risk')} accepted-risk — review `memory_injection_review_queue`",
        END_MARK,
    ]
    return "\n".join(lines)


def fetch_memory(client):
    r = client.get(
        f"{SUPABASE_URL}/rest/v1/memories",
        params={"select": "id,name,content", "name": f"eq.{STATE_MEMORY_NAME}",
                "is_active": "is.true", "limit": "1"},
        headers=sb_headers(),
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


def splice(content, block):
    """Replace the marked region, or prepend if the markers are not there yet."""
    i = content.find(BEGIN_MARK)
    j = content.find(END_MARK)
    if i != -1 and j != -1 and j > i:
        return content[:i] + block + content[j + len(END_MARK):]
    return block + "\n\n" + content


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_KEY:
        log.error("SUPABASE_SECRET_KEY not set")
        return 1

    with httpx.Client() as client:
        gt = ground_truth(client)
        health = service_health(client)
        block = render_block(health, gt, disk_migration_head())

        mem = fetch_memory(client)
        if not mem:
            log.error("no active memory named %r — nothing to refresh", STATE_MEMORY_NAME)
            return 1

        new_content = splice(mem["content"], block)

        # Compare ignoring the generated_at line, which changes every run by
        # construction. Without this the "nothing changed" path would never be
        # taken and the row would churn nightly for no reason.
        def strip_ts(s):
            return "\n".join(l for l in s.splitlines() if not l.startswith("**Generated:**"))

        if strip_ts(new_content) == strip_ts(mem["content"]):
            log.info("state memory already current — no write")
            return 0

        if args.dry_run:
            log.info("DRY RUN — would write:\n%s", block)
            return 0

        r = client.patch(
            f"{SUPABASE_URL}/rest/v1/memories",
            params={"id": f"eq.{mem['id']}"},
            # embedding=NULL so startEmbeddingBackfillJob re-embeds; a direct SQL
            # write bypasses remember()'s re-embed and would leave a stale vector.
            json={"content": new_content, "embedding": None},
            headers=sb_headers({"Prefer": "return=minimal"}),
            timeout=60,
        )
        r.raise_for_status()
        log.info("state memory refreshed (%d chars, %d-char generated block)",
                 len(new_content), len(block))
        log.info("ground truth: %s", json.dumps({
            "version": health.get("version"),
            "migration_head_applied": gt["migration_head_applied"],
            "active_probes": gt["eval"]["active_probes"],
            "tiers": gt["eval"]["by_tier"],
        }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
