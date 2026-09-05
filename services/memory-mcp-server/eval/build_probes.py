#!/usr/bin/env python3
"""
Probe miner for the retrieval regression gate (2026-07-24 research rec 2).

The hand-curated seed (datasets/eval_queries_seed.json, 38 probes) is high quality but
below the 50-100 the research called for. This mines additional probes from the two
sources the research named — high `recall_count` memories (rows the fleet actually
leans on, so retrieving them matters most) — and inserts them into eval_queries under a
SEPARATE category so curated vs mined stay auditable and prunable.

Each mined probe is a self-retrieval check: the memory's human-written one-line
`description` is a legitimate natural query, and the memory id is the gold. Reported
per-category by retrieval_regression.py, so a too-easy mined set can never silently
mask a curated-set regression.

USAGE
  python3 build_probes.py                 # dry-run: print candidates, write JSON only
  python3 build_probes.py --commit --n 20 # insert up to N new probes into eval_queries
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
OUT_JSON = Path(__file__).resolve().parent / "datasets" / "mined_high_recall.json"


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_env()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}
STOP = {"the", "a", "an", "of", "for", "and", "to", "in", "on", "is", "with", "via"}
# Point-in-time log series + generic consolidation summaries make ambiguous probes
# (near-identical descriptions across many rows → unwinnable gold). Exclude them so the
# mined set stays a fair, discriminating gate rather than noise.
SKIP_NAME = re.compile(r"\d{4}-\d{2}-\d{2}|research|distilled|dreaming|weekly.?ref|consolidat|triage|breakthrough", re.I)
SKIP_DESC = re.compile(r"^(distilled from|daily .*research|weekly consolidation)", re.I)


def sb_get(path, params):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_post(path, body):
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/{path}",
                   headers={**SB_HEADERS, "Prefer": "return=representation"}, json=body, timeout=45)
    r.raise_for_status()
    return r.json()


def topic_hint(name: str) -> str:
    words = [w for w in re.split(r"[_\W]+", name.lower()) if w and w not in STOP]
    return " ".join(words[:5])


def existing_gold_ids() -> set:
    out = set()
    for q in sb_get("eval_queries", {"select": "gold_memory_ids"}):
        out.update(q.get("gold_memory_ids") or [])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="insert into eval_queries (else dry-run)")
    ap.add_argument("--n", type=int, default=20, help="max new probes to add")
    ap.add_argument("--min-recall", type=int, default=8, help="recall_count floor for candidates")
    args = ap.parse_args()
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SECRET_KEY missing (expected in ../.env)", file=sys.stderr)
        sys.exit(2)

    covered = existing_gold_ids()
    rows = sb_get("memories", {
        "select": "id,name,description,recall_count,type",
        "recall_count": f"gte.{args.min_recall}",
        "is_active": "is.true",
        "description": "not.is.null",
        "order": "recall_count.desc",
        "limit": "200",
    })
    probes, seen_desc = [], set()
    for m in rows:
        if m["id"] in covered:
            continue
        name, desc = m.get("name") or "", (m.get("description") or "").strip()
        if len(desc) < 25:                       # too thin to be a fair query
            continue
        if SKIP_NAME.search(name) or SKIP_DESC.match(desc):
            continue
        norm = re.sub(r"\W+", " ", desc.lower()).strip()[:80]
        if norm in seen_desc:                    # ambiguous: same query text, different gold
            continue
        seen_desc.add(norm)
        probes.append({
            "question": desc,
            "topic_hint": topic_hint(m["name"]),
            "gold_memory_ids": [m["id"]],
            "category": "mined_high_recall",
            "notes": f"auto-mined: {m['name']} (recall_count={m['recall_count']})",
            "active": True,
        })
        if len(probes) >= args.n:
            break

    OUT_JSON.parent.mkdir(exist_ok=True)
    OUT_JSON.write_text(json.dumps(probes, indent=2))
    print(f"{len(probes)} candidate probes written to {OUT_JSON}")
    for p in probes:
        print(f"  [{p['topic_hint'][:28]:<28}] {p['question'][:64]}")

    if args.commit and probes:
        inserted = sb_post("eval_queries", probes)
        print(f"\ninserted {len(inserted)} probes into eval_queries (category=mined_high_recall)")
    elif not args.commit:
        print("\n(dry-run — pass --commit to insert)")


if __name__ == "__main__":
    main()
