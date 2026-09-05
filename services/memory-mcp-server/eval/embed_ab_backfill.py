#!/usr/bin/env python3
"""
embed_ab_backfill.py — populate memories.embedding_v2 with a CANDIDATE embedding
model, so retrieval_regression.py can score it against the live nomic-embed-text
arm through the real recall path (migration 113).

REC 1, 2026-08-03 Daily Self-Improvement Research. nomic-embed-text (768d,
MTEB ~62.28) has been the embedding model since day one and is the only knob on
the retrieval path that was never revisited.

WHAT IT DOES
    For every active memory: rebuild the EXACT embed input the server uses
    (embedInput() in src/index.ts, `name: description\\n\\ncontent` capped at
    4000 chars), embed it with the candidate model, MRL-truncate to 768 dims,
    L2-renormalise, and write it to memories.embedding_v2.

WHY THE EMBED INPUT MUST MATCH BYTE-FOR-BYTE
    If this script embedded, say, content alone while the live column holds
    name+description+content, the A/B would compare two different corpora and
    report it as a model difference. The one thing an A/B has to get right is
    that only the independent variable moves.

MATRYOSHKA TRUNCATION
    qwen3-embedding:0.6b emits 1024 dims. It is an MRL model, so a prefix of the
    vector is a valid lower-dimensional embedding — but ONLY after re-normalising
    to unit length, because the discarded tail carried part of the norm. Cosine
    distance on un-renormalised truncations is subtly wrong in a way that looks
    like mediocre model quality rather than a bug. See --no-renorm to ablate.

QUERY-SIDE ASYMMETRY (--instruct)
    Qwen3-Embedding is trained for asymmetric retrieval: documents are embedded
    raw, queries get an instruction prefix. Embedding queries raw too is a real
    handicap, so retrieval_regression.py applies the same prefix on the query
    side when EMBED_QUERY_INSTRUCT is set. This script only writes DOCUMENTS, so
    it deliberately does NOT apply a prefix — it just records the convention.

USAGE
    python3 embed_ab_backfill.py --model qwen3-embedding:0.6b
    python3 embed_ab_backfill.py --model qwen3-embedding:0.6b --limit 20 --dry-run
    python3 embed_ab_backfill.py --verify        # report coverage, embed nothing
"""
import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import httpx

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


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
OLLAMA_URL = os.environ.get("OLLAMA_URL_HOST", "http://localhost:11434").rstrip("/")

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

TARGET_DIMS = 768          # must equal the vector(N) width of embedding_v2
EMBED_INPUT_CAP = 4000     # mirrors embedInput() in src/index.ts


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def embed_input(name: str, description: str, content: str) -> str:
    """Byte-identical to embedInput() in src/index.ts."""
    return f"{name or ''}: {description or ''}\n\n{content or ''}"[:EMBED_INPUT_CAP]


def embed(text: str, model: str, attempts: int = 4) -> list:
    """Embed with bounded retry — Ollama refuses connections for a few seconds
    when it swaps models, and an unretried failure here would silently leave
    NULLs that the eval would score as misses (cf. the 2026-07-28 artefact run)."""
    last = None
    for i in range(attempts):
        try:
            r = httpx.post(f"{OLLAMA_URL}/api/embeddings",
                           json={"model": model, "prompt": text}, timeout=60)
            r.raise_for_status()
            return r.json()["embedding"]
        except Exception as e:
            last = e
            if i < attempts - 1:
                time.sleep(1.5 * (2 ** i))
    raise last


def mrl_truncate(vec: list, dims: int = TARGET_DIMS, renorm: bool = True) -> list:
    """Matryoshka-truncate to `dims` and restore unit norm.

    The renormalise is not cosmetic: cosine distance assumes unit vectors, and
    lopping off dims removes part of the norm. Skipping it makes every candidate
    look slightly worse in a way that is indistinguishable from model quality."""
    if len(vec) < dims:
        die(f"model returned {len(vec)} dims, need at least {dims}")
    out = vec[:dims]
    if not renorm:
        return out
    norm = math.sqrt(sum(x * x for x in out))
    if norm == 0:
        die("zero-norm embedding — refusing to write")
    return [x / norm for x in out]


def sb_get(path, params):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS,
                  params=params, timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_active(only_missing: bool = False):
    """Page through active memories. PostgREST caps rows per request, so a single
    unpaged GET would silently backfill only the first page and report success.

    only_missing restricts to rows with no embedding_v2 yet, which makes the
    backfill RESUMABLE and idempotent. That matters more than it looks: the
    corpus grows while a ~2h backfill runs (agents write memories throughout),
    so a run that embedded a snapshot taken at start always finishes with a few
    rows still NULL. Without this flag the only way to catch them is to re-embed
    all ~840 from scratch."""
    rows, offset, page = [], 0, 500
    while True:
        params = {
            "select": "id,name,description,content",
            "is_active": "not.is.false",
            "order": "id",
            "offset": str(offset),
            "limit": str(page),
        }
        if only_missing:
            params["embedding_v2"] = "is.null"
        batch = sb_get("memories", params)
        rows.extend(batch)
        if len(batch) < page:
            return rows
        offset += page


def write_vec(mem_id: str, vec: list):
    r = httpx.patch(f"{SUPABASE_URL}/rest/v1/memories",
                    headers={**SB_HEADERS, "Prefer": "return=minimal"},
                    params={"id": f"eq.{mem_id}"},
                    json={"embedding_v2": json.dumps(vec)}, timeout=60)
    r.raise_for_status()


def cmd_verify():
    got = sb_get("memories", {"select": "id", "is_active": "not.is.false",
                              "embedding_v2": "not.is.null", "limit": "1"},)
    # count via Prefer: count=exact is cleaner, but a HEAD count keeps this simple
    active = len(fetch_active())
    filled = len([r for r in sb_get("memories", {
        "select": "id", "is_active": "not.is.false",
        "embedding_v2": "not.is.null", "limit": "5000"})])
    print(f"active memories        : {active}")
    print(f"embedding_v2 populated : {filled}")
    print(f"missing                : {active - filled}")
    return 0 if filled == active else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="qwen3-embedding:0.6b")
    ap.add_argument("--limit", type=int, default=None, help="only embed the first N (smoke test)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-renorm", action="store_true",
                    help="ablation: truncate WITHOUT restoring unit norm")
    ap.add_argument("--verify", action="store_true", help="report coverage and exit")
    ap.add_argument("--only-missing", action="store_true",
                    help="embed only rows with a NULL embedding_v2 (resumable catch-up pass)")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        die("SUPABASE_URL / SUPABASE_SECRET_KEY not set")

    if args.verify:
        return cmd_verify()

    rows = fetch_active(only_missing=args.only_missing)
    if args.limit:
        rows = rows[:args.limit]
    print(f"Embedding {len(rows)} active memories with {args.model} "
          f"-> {TARGET_DIMS}d{' (no renorm)' if args.no_renorm else ''}")

    t0, done, failed = time.time(), 0, []
    for i, m in enumerate(rows, 1):
        text = embed_input(m.get("name"), m.get("description"), m.get("content"))
        try:
            vec = mrl_truncate(embed(text, args.model), renorm=not args.no_renorm)
        except Exception as e:
            failed.append((m["id"], str(e)[:120]))
            continue
        if not args.dry_run:
            try:
                write_vec(m["id"], vec)
            except Exception as e:
                failed.append((m["id"], f"write: {str(e)[:120]}"))
                continue
        done += 1
        if i % 50 == 0 or i == len(rows):
            rate = i / max(time.time() - t0, 1e-6)
            print(f"  {i}/{len(rows)}  ({rate:.1f}/s)")

    dt = time.time() - t0
    print(f"\ndone: {done} embedded, {len(failed)} failed, {dt:.1f}s")
    if failed:
        # Loud, not swallowed: a partial backfill scores as a retrieval
        # regression for the candidate arm and would get read as model quality.
        print("FAILURES (candidate arm is INCOMPLETE — do not score this run):",
              file=sys.stderr)
        for mid, err in failed[:20]:
            print(f"  {mid}  {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
