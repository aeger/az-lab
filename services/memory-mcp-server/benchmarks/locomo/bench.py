#!/usr/bin/env python3
"""LOCOMO benchmark harness for memory-mcp-server v5.7.0.

Stages: ingest | eval | summarize | cleanup
Uses Supabase REST API (service role) + Ollama nomic-embed-text.
Isolates eval data with agent_id='locomo-<sample_id>' + visibility='private'.

GATING (added 2026-05-02 after one run left ~6K rows behind and overloaded
Supabase IO/CPU):
  - Every ingested row gets `expires_at = now() + INGEST_TTL_HOURS`. If
    cleanup is skipped, an expires_at sweep eventually reclaims the rows.
  - Pre-flight refuses to ingest if SOURCE_TAG rows already exist.
  - `all` mode runs cleanup in try/finally.
  - Hard cap MAX_INGEST_ROWS prevents accidental runs over the corpus size.
  - `--keep-data` is the explicit opt-out for `all`.
"""
from __future__ import annotations
import argparse, json, os, statistics, sys, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests

ENV_PATH = Path("/home/almty1/azlab/services/memory-mcp-server/.env")
DATA = Path(__file__).parent / "locomo10.json"
RESULTS = Path(__file__).parent / "results.json"

OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "nomic-embed-text"
EMBED_DIM = 768
SOURCE_TAG = "locomo-bench-v5.7.0"

# Outer-bound guards. The benchmark corpus is ~5,900 rows; cap at 7,500 to
# catch a runaway loop and leave headroom. TTL sets an absolute backstop on
# how long bench data can sit in production memories.
MAX_INGEST_ROWS = 7500
INGEST_TTL_HOURS = 4


def load_env() -> dict[str, str]:
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def sb_headers(env: dict) -> dict:
    k = env["SUPABASE_SECRET_KEY"]
    return {"apikey": k, "Authorization": f"Bearer {k}", "Content-Type": "application/json"}


def embed(text: str) -> list[float]:
    r = requests.post(f"{OLLAMA_URL}/api/embeddings",
                      json={"model": EMBED_MODEL, "prompt": text}, timeout=60)
    r.raise_for_status()
    v = r.json()["embedding"]
    if len(v) != EMBED_DIM:
        raise RuntimeError(f"unexpected embedding dim {len(v)}")
    return v


def vec_str(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def topic_hint(question: str) -> str:
    """Cheap MIRIX-style topic distillation: 3-5 content words from question."""
    stop = {"what","when","where","who","whom","whose","why","how","is","are","was","were",
            "do","does","did","the","a","an","of","to","in","on","at","by","for","with",
            "and","or","but","that","this","these","those","it","its","there","their",
            "have","has","had","be","been","being","will","would","could","should","may",
            "might","can","not","no","yes","you","i","we","they","he","she","my","your"}
    words = [w.strip(".,?!:;\"'()[]").lower() for w in question.split()]
    keep = [w for w in words if w and w not in stop and len(w) > 2]
    return " ".join(keep[:5]) if keep else question[:40]


def load_locomo() -> list[dict]:
    return json.loads(DATA.read_text())


def turns_for_conv(conv: dict) -> list[tuple[str, str, str, str]]:
    """Return [(dia_id, speaker, text, session_dt)]."""
    out = []
    sess_keys = sorted([k for k in conv if k.startswith("session_") and not k.endswith("_date_time")],
                       key=lambda k: int(k.split("_")[1]))
    for sk in sess_keys:
        dt = conv.get(f"{sk}_date_time", "")
        for t in conv[sk]:
            out.append((t["dia_id"], t["speaker"], t["text"], dt))
    return out


# ---------- INGEST ----------
def preflight(env):
    """Refuse to ingest if a previous run's data is still in the table.

    Catches the failure mode where someone runs `ingest` or `eval` and exits
    without `cleanup` — the rows linger and bloat the production memories
    table indefinitely.
    """
    headers = sb_headers(env)
    url = env["SUPABASE_URL"] + "/rest/v1/memories"
    r = requests.get(
        f"{url}?source=eq.{SOURCE_TAG}&select=id",
        headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
        timeout=30,
    )
    r.raise_for_status()
    cr = r.headers.get("content-range", "0-0/0")
    n = int(cr.split("/")[-1] or "0")
    if n > 0:
        sys.exit(
            f"[preflight] REFUSING TO INGEST — {n} rows already tagged "
            f"source={SOURCE_TAG} in memories. Run `cleanup` first."
        )


def ingest(env, batch_size=50, sleep=0.0):
    preflight(env)
    data = load_locomo()
    headers = sb_headers(env)
    base = env["SUPABASE_URL"] + "/rest/v1/memories"
    total = sum(len(turns_for_conv(s["conversation"])) for s in data)
    if total > MAX_INGEST_ROWS:
        sys.exit(
            f"[ingest] REFUSING — corpus has {total} turns, exceeds "
            f"MAX_INGEST_ROWS={MAX_INGEST_ROWS}. Bump the cap intentionally if needed."
        )
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=INGEST_TTL_HOURS)).isoformat()
    print(f"[ingest] {total} turns across {len(data)} conversations  (expires_at={expires_at})")
    done = 0
    t0 = time.time()
    for sample in data:
        sid = sample["sample_id"]
        agent_id = f"locomo-{sid}"
        speaker_a = sample["conversation"].get("speaker_a", "")
        speaker_b = sample["conversation"].get("speaker_b", "")
        rows_buf = []
        for dia_id, speaker, text, dt in turns_for_conv(sample["conversation"]):
            content = f"{speaker}: {text}"
            try:
                v = embed(content)
            except Exception as e:
                print(f"[ingest] embed fail {sid}/{dia_id}: {e}", file=sys.stderr)
                continue
            row = {
                "type": "reference",  # neutral; conforms to existing CHECK
                "name": f"{sid} {dia_id} {speaker}",
                "description": dt or f"{speaker_a}/{speaker_b}",
                "content": content,
                "tags": ["locomo", sid, dia_id, speaker],
                "source": SOURCE_TAG,
                "embedding": vec_str(v),
                "agent_id": agent_id,
                "visibility": "private",
                "memory_class": "episodic",
                "importance_score": 0.5,
                "confidence": 0.9,
                "expires_at": expires_at,  # backstop: rows self-expire if cleanup is skipped
            }
            rows_buf.append(row)
            done += 1
            if len(rows_buf) >= batch_size:
                _post_rows(base, headers, rows_buf)
                rows_buf = []
                rate = done / (time.time() - t0)
                print(f"[ingest] {done}/{total}  {rate:.1f}/s  ({sid})", flush=True)
                if sleep:
                    time.sleep(sleep)
        if rows_buf:
            _post_rows(base, headers, rows_buf)
    print(f"[ingest] complete in {time.time()-t0:.0f}s")


def _post_rows(url, headers, rows):
    r = requests.post(url, headers={**headers, "Prefer": "return=minimal"}, json=rows, timeout=60)
    if r.status_code >= 300:
        print(f"[ingest] HTTP {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()


# ---------- EVAL ----------
def eval_run(env, categories=(1, 2, 3), top_k=20, fetch_k=40, limit_per_conv=None):
    """Fetch fetch_k rows, post-filter to the conversation's sid tag, take top_k for metrics.

    The RPC's agent_id filter accepts shared|matching, so production memories leak into
    results. Filtering by the sid tag isolates the LOCOMO conversation.
    """
    data = load_locomo()
    headers = sb_headers(env)
    rpc_url = env["SUPABASE_URL"] + "/rest/v1/rpc/hybrid_recall"
    results = []
    print(f"[eval] categories={categories} top_k={top_k} fetch_k={fetch_k}")
    t0 = time.time()
    for sample in data:
        sid = sample["sample_id"]
        agent_id = f"locomo-{sid}"
        qs = [q for q in sample["qa"] if q.get("category") in categories and q.get("evidence")]
        if limit_per_conv:
            qs = qs[:limit_per_conv]
        for q in qs:
            question = q["question"]
            evidence = set(q["evidence"])
            try:
                qv = embed(question)
            except Exception as e:
                print(f"[eval] embed fail: {e}", file=sys.stderr)
                continue
            payload = {
                "p_query_text": question,
                "p_query_embedding": vec_str(qv),
                "p_match_threshold": 0.0,
                "p_match_count": fetch_k,
                "p_filter_type": None,
                "p_agent_id": agent_id,
                "p_agent_scope": None,
                "p_min_confidence": 0.0,
                "p_memory_class": None,
                "p_topic_hint": topic_hint(question),
            }
            rows = None
            for attempt in range(3):
                r = requests.post(rpc_url, headers=headers, json=payload, timeout=60)
                if r.status_code < 300:
                    rows = r.json()
                    break
                if "57014" in r.text and attempt < 2:  # statement_timeout, retry
                    time.sleep(1.0 + attempt)
                    continue
                print(f"[eval] RPC {r.status_code} ({sid}): {r.text[:160]}", file=sys.stderr)
                break
            if rows is None:
                continue
            ranked_dias = []
            for row in rows:
                tags = row.get("tags") or []
                if sid not in tags:
                    continue
                dia = next((t for t in tags if t.startswith("D") and ":" in t), None)
                if dia:
                    ranked_dias.append(dia)
                if len(ranked_dias) >= top_k:
                    break
            results.append({
                "sid": sid, "category": q["category"],
                "question": question, "evidence": list(evidence),
                "ranked": ranked_dias,
                "n_returned": len(rows),
            })
        elapsed = time.time() - t0
        print(f"[eval] {sid} done ({len(qs)} q)  elapsed={elapsed:.0f}s", flush=True)
    RESULTS.write_text(json.dumps(results, indent=2))
    print(f"[eval] saved {len(results)} results to {RESULTS}")


# ---------- SCORE ----------
def score():
    rs = json.loads(RESULTS.read_text())
    by_cat = defaultdict(list)
    overall = []
    for r in rs:
        ev = set(r["evidence"])
        ranked = r["ranked"]
        # MRR: 1/rank of first evidence dia, else 0
        rr = 0.0
        for i, d in enumerate(ranked, 1):
            if d in ev:
                rr = 1.0 / i
                break
        # Recall@K
        def rec_at(k):
            top = set(d for d in ranked[:k] if d)
            return len(top & ev) / max(1, len(ev))
        scores = {"mrr": rr, "r1": rec_at(1), "r5": rec_at(5),
                  "r10": rec_at(10), "r20": rec_at(20)}
        by_cat[r["category"]].append(scores)
        overall.append(scores)

    def agg(rows):
        return {k: round(statistics.mean([r[k] for r in rows]), 4) for k in
                ["mrr", "r1", "r5", "r10", "r20"]}

    cat_names = {1: "single-hop", 2: "multi-hop", 3: "temporal"}
    summary = {"overall": agg(overall),
               "by_category": {f"{c}_{cat_names.get(c,c)}": agg(rs) for c, rs in sorted(by_cat.items())},
               "n_questions": len(overall),
               "n_per_category": {c: len(rs) for c, rs in by_cat.items()}}
    print(json.dumps(summary, indent=2))
    return summary


# ---------- CLEANUP ----------
def cleanup(env):
    headers = sb_headers(env)
    url = env["SUPABASE_URL"] + "/rest/v1/memories"
    # delete all rows where source = SOURCE_TAG
    r = requests.delete(f"{url}?source=eq.{SOURCE_TAG}", headers=headers, timeout=120)
    print(f"[cleanup] HTTP {r.status_code}: {r.text[:200]}")


# ---------- MAIN ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["ingest", "eval", "score", "cleanup", "all"])
    ap.add_argument("--limit-per-conv", type=int, default=None)
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--cats", default="1,2,3")
    ap.add_argument("--keep-data", action="store_true",
                    help="Skip the auto-cleanup at the end of `all`. Use only when you "
                         "intentionally want bench rows to linger for debugging — "
                         "they still expire after INGEST_TTL_HOURS.")
    args = ap.parse_args()
    env = load_env()
    cats = tuple(int(x) for x in args.cats.split(","))
    if args.stage == "all":
        # try/finally so even on eval/score failure, cleanup still runs unless
        # the operator explicitly opted out.
        try:
            ingest(env)
            eval_run(env, categories=cats, top_k=args.top_k, limit_per_conv=args.limit_per_conv)
            score()
        finally:
            if args.keep_data:
                print("[bench] --keep-data set; skipping auto-cleanup. "
                      f"Rows expire automatically after {INGEST_TTL_HOURS}h.")
            else:
                cleanup(env)
        return
    if args.stage == "ingest":
        ingest(env)
        print(f"[ingest] WARNING — bench rows are in production memories. Run "
              f"`bench.py cleanup` when done. Auto-expire in {INGEST_TTL_HOURS}h.")
    if args.stage == "eval":
        eval_run(env, categories=cats, top_k=args.top_k, limit_per_conv=args.limit_per_conv)
    if args.stage == "score":
        score()
    if args.stage == "cleanup":
        cleanup(env)


if __name__ == "__main__":
    main()
