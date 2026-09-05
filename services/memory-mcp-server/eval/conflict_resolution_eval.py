#!/usr/bin/env python3
"""
FactConsolidation-style regression eval for the deterministic conflict resolver
(migration 063).  Tier 3 of the 2026-07-22 daily self-improvement research.

WHY THIS EXISTS
    The research asked for ~30 of the existing conflicts as gold data so that
    resolver changes become falsifiable.  The conflict table turned out to be
    the wrong gold source: only 2 of the 52 resolved 'contradiction' rows have
    an unambiguous winner recorded, because contradictions were closed by
    review rather than by supersession.

    The real labelled data is the supersession graph itself.  Every
    memory_links row with relationship='supersedes' is a (loser -> winner)
    pair that a human or agent already adjudicated: supersede_memory() writes
    the edge loser->winner and sets memories.superseded_by on the loser.  As of
    2026-07-22 there are 33 such pairs.  Those are the gold set.

WHAT IT SCORES
    1. RESOLVER ACCURACY — for each gold pair, does the deterministic ordering
       key pick the side that was actually kept?  Two keys are scored
       side by side:
         * key_content  = (version, content_timestamp, created_at, id)
              what migration 063 actually uses
         * key_updated  = (version, updated_at, created_at, id)
              the literal 2026-07-22 recommendation
       Reporting both is the point.  memories.updated_at is rewritten on every
       row nightly by the decay/PageRank jobs, so key_updated is expected to
       score near chance.  If it ever scores well, that assumption changed and
       063's comment block needs revisiting.

    2. FAMA PENALTY (arXiv:2604.20006) — reliance on invalidated memory.  For
       each gold loser, is it still reachable at full rank?  Measures two
       things: whether the row is excluded from recall at all, and what
       governance_weight() would multiply its score by.  A loser that recall
       would serve unpenalised is a FAMA violation.

    3. STALE-PROPAGATION RESIDUE — how many stale links still point at a
       superseded row instead of its supersession head.  This is what
       resolve_conflict_auto()'s stale branch repairs; it should trend to zero
       and stay there.

USAGE
    cd ~/azlab/services/memory-mcp-server
    python3 eval/conflict_resolution_eval.py            # score, print report
    python3 eval/conflict_resolution_eval.py --json     # machine-readable
    python3 eval/conflict_resolution_eval.py --freeze   # rewrite the gold set

    Exits non-zero if resolver accuracy on the frozen gold set REGRESSES
    against eval/conflict_resolution_gold.json, so it can gate a deploy.

Gold set is frozen to disk so the eval stays a fixed regression target even as
the live supersession graph grows.  Re-freeze deliberately, not incidentally.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF", "ogqjjlbupqnvlcyrfnxi")
API = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
HERE = pathlib.Path(__file__).resolve().parent
GOLD_PATH = HERE / "conflict_resolution_gold.json"


def load_token():
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if tok:
        return tok
    env = HERE.parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("SUPABASE_ACCESS_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("SUPABASE_ACCESS_TOKEN not set and not found in .env")


def q(sql):
    """Run SQL via the Supabase management API.

    NOTE: a User-Agent header is required — without it Cloudflare answers 403
    'error code: 1010' and the failure looks like a bad token.
    """
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {load_token()}",
            "Content-Type": "application/json",
            "User-Agent": "azlab-eval/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"query failed {e.code}: {e.read().decode()[:500]}")


# ── Gold set ─────────────────────────────────────────────────────────────────

GOLD_SQL = """
SELECT l.source_id::text AS loser_id,
       l.target_id::text AS winner_id,
       ml.name           AS loser_name,
       mw.name           AS winner_name,
       ml.type           AS loser_type
FROM memory_links l
JOIN memories ml ON ml.id = l.source_id
JOIN memories mw ON mw.id = l.target_id
WHERE l.relationship = 'supersedes'
  AND ml.superseded_by IS NOT NULL
ORDER BY l.created_at, l.source_id
"""


def build_gold():
    rows = q(GOLD_SQL)
    return {
        "note": "Gold set for the deterministic conflict resolver (migration 063). "
                "Each entry is an adjudicated (loser, winner) supersession pair. "
                "Frozen deliberately — re-run with --freeze to update.",
        "pairs": rows,
    }


# ── Scoring ──────────────────────────────────────────────────────────────────

SCORE_SQL = """
WITH gold(loser_id, winner_id) AS (VALUES {values}),
p AS (
  SELECT g.loser_id, g.winner_id,
         lo.version   AS lo_ver,  wi.version   AS wi_ver,
         public.content_timestamp(lo.id) AS lo_cts,
         public.content_timestamp(wi.id) AS wi_cts,
         lo.updated_at AS lo_upd, wi.updated_at AS wi_upd,
         lo.created_at AS lo_cre, wi.created_at AS wi_cre,
         lo.id AS lo_id, wi.id AS wi_id,
         lo.is_active AS lo_active,
         public.governance_weight(lo.superseded_by, lo.conflict_flagged) AS lo_gw
  FROM gold g
  JOIN memories lo ON lo.id = g.loser_id
  JOIN memories wi ON wi.id = g.winner_id
)
SELECT
  count(*) AS n,
  -- the key migration 063 uses: winner must sort ABOVE loser
  count(*) FILTER (
    WHERE (wi_ver, wi_cts, wi_cre, wi_id) > (lo_ver, lo_cts, lo_cre, lo_id)
  ) AS correct_content,
  -- the literal recommendation, using updated_at
  count(*) FILTER (
    WHERE (wi_ver, wi_upd, wi_cre, wi_id) > (lo_ver, lo_upd, lo_cre, lo_id)
  ) AS correct_updated,
  -- Discrimination detail.  Whole-tuple accuracy flatters BOTH keys, because
  -- on this corpus 32/33 gold pairs tie on `version` and 13 of those also tie
  -- on `updated_at` (the nightly batch stamps one now() across every row), so
  -- comparison falls through to the created_at tiebreak and lands correct by
  -- accident.  The honest question is: among pairs where the timestamp is the
  -- deciding field, how often does each timestamp decide correctly?
  count(*) FILTER (WHERE wi_ver = lo_ver) AS version_ties,
  count(*) FILTER (WHERE wi_ver = lo_ver AND wi_cts > lo_cts) AS tie_content_ok,
  count(*) FILTER (WHERE wi_ver = lo_ver AND wi_upd > lo_upd) AS tie_updated_ok,
  count(*) FILTER (WHERE wi_ver = lo_ver AND wi_upd = lo_upd) AS tie_updated_degenerate,
  -- FAMA: losers still servable by recall at full weight
  count(*) FILTER (WHERE lo_active IS NOT FALSE) AS losers_still_active,
  count(*) FILTER (WHERE lo_gw >= 1.0)           AS losers_unpenalised,
  round(avg(lo_gw)::numeric, 4)                  AS mean_loser_weight
FROM p
"""

RESIDUE_SQL = """
SELECT count(*) AS stale_links_remaining
FROM memory_links l
JOIN memories t ON t.id = l.target_id
WHERE t.superseded_by IS NOT NULL
  AND l.relationship <> 'supersedes'
  AND COALESCE(l.strength, 0.5) > 0.05
"""

OPEN_SQL = """
SELECT conflict_type, count(*) AS open
FROM memory_conflicts
WHERE COALESCE(resolved, false) = false
GROUP BY 1 ORDER BY 2 DESC
"""


def score(pairs):
    if not pairs:
        sys.exit("gold set is empty — run with --freeze once the supersession graph is populated")
    values = ", ".join(
        f"('{p['loser_id']}'::uuid, '{p['winner_id']}'::uuid)" for p in pairs
    )
    row = q(SCORE_SQL.format(values=values))[0]
    row["stale_links_remaining"] = q(RESIDUE_SQL)[0]["stale_links_remaining"]
    row["open_conflicts"] = q(OPEN_SQL)
    n = row["n"] or 1
    row["acc_content"] = round(row["correct_content"] / n, 4)
    row["acc_updated"] = round(row["correct_updated"] / n, 4)
    ties = row["version_ties"] or 1
    row["tie_acc_content"] = round(row["tie_content_ok"] / ties, 4)
    row["tie_acc_updated"] = round(row["tie_updated_ok"] / ties, 4)
    return row


def report(r, gold_n, baseline):
    print("=" * 72)
    print("Conflict-resolution regression eval — migration 063")
    print("=" * 72)
    print(f"gold pairs (frozen): {gold_n}   scored: {r['n']}")
    print()
    print("1. RESOLVER ACCURACY — does the ordering key pick the adjudicated winner?")
    print(f"   (version, content_timestamp)  {r['correct_content']:>3}/{r['n']}  "
          f"= {r['acc_content']:.1%}   <- migration 063")
    print(f"   (version, updated_at)         {r['correct_updated']:>3}/{r['n']}  "
          f"= {r['acc_updated']:.1%}   <- literal 2026-07-22 recommendation")
    print("   ^ whole-tuple accuracy flatters both keys — read 1b, not this.")
    print()
    print("1b. TIEBREAK DISCRIMINATION — the number that actually matters")
    print(f"   pairs tied on version: {r['version_ties']}/{r['n']} "
          f"(so the timestamp, not version, is the deciding field)")
    print(f"   content_timestamp decides correctly  {r['tie_content_ok']:>3}/{r['version_ties']}"
          f"  = {r['tie_acc_content']:.1%}")
    print(f"   updated_at decides correctly         {r['tie_updated_ok']:>3}/{r['version_ties']}"
          f"  = {r['tie_acc_updated']:.1%}")
    print(f"   ...of which updated_at is exactly EQUAL on {r['tie_updated_degenerate']} pairs "
          f"(nightly batch stamps one now() corpus-wide)")
    if r["tie_acc_updated"] >= r["tie_acc_content"]:
        print("   !! updated_at is no longer degenerate — revisit migration 063 §1b")
    print()
    print("2. FAMA PENALTY — reliance on invalidated memory (arXiv:2604.20006)")
    print(f"   losers still is_active        {r['losers_still_active']}/{r['n']}")
    print(f"   losers at full recall weight  {r['losers_unpenalised']}/{r['n']}")
    print(f"   mean governance_weight        {r['mean_loser_weight']}")
    print()
    print("3. STALE-PROPAGATION RESIDUE")
    print(f"   links to superseded rows at strength > 0.05: {r['stale_links_remaining']}")
    print(f"   open conflicts: {r['open_conflicts']}")
    print()

    if baseline:
        prev = baseline.get("acc_content")
        if prev is not None and r["acc_content"] < prev:
            print(f"REGRESSION: acc_content {prev:.1%} -> {r['acc_content']:.1%}")
            return 1
        print(f"no regression (baseline acc_content {prev:.1%})" if prev is not None else "")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true", help="rewrite the frozen gold set")
    ap.add_argument("--json", action="store_true", help="emit machine-readable results")
    args = ap.parse_args()

    if args.freeze or not GOLD_PATH.exists():
        gold = build_gold()
        GOLD_PATH.write_text(json.dumps(gold, indent=2))
        print(f"froze {len(gold['pairs'])} gold pairs -> {GOLD_PATH}")
        if args.freeze:
            return 0
    else:
        gold = json.loads(GOLD_PATH.read_text())

    r = score(gold["pairs"])
    baseline = gold.get("baseline")

    if args.json:
        print(json.dumps(r, indent=2, default=str))
        return 0

    rc = report(r, len(gold["pairs"]), baseline)

    if baseline is None:
        gold["baseline"] = {"acc_content": r["acc_content"], "acc_updated": r["acc_updated"]}
        GOLD_PATH.write_text(json.dumps(gold, indent=2))
        print(f"recorded first baseline in {GOLD_PATH}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
