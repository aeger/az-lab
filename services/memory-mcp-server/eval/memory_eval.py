#!/usr/bin/env python3
"""memory_eval.py — measure whether INJECTING memory into an agent's context
improves its ability to answer questions that depend on that memory.

This is the eval harness for the "memory injection" research question: the store
+ retrieval are ~solved; the open problem is *binding* — does pushing relevant
memory into context (ambient) actually make the agent answer better than making
it pull on demand, or than nothing at all?

It compares injection STRATEGIES on a dataset of QA pairs auto-generated from the
live memory store, using the system's REAL retrieval path:
  embeddings : Ollama `nomic-embed-text` (768d)   — same as the MCP server
  retrieval  : `hybrid_recall` RPC (BM25 + vector RRF) — same as the `recall` tool

Strategies (the independent variable), each injects up to K memories:
  none      no memory (baseline — pure parametric answer)
  recency   K most-recently-updated active memories (the naive "load recent" default)
  random    K random active memories (control — is any context better than none?)
  semantic  hybrid_recall, vector-only (embedding similarity to the question)
  hybrid    hybrid_recall, BM25 + vector (the system's real default retrieval)
  oracle    the single gold memory the question was generated from (upper bound)

Metrics per strategy:
  accuracy      mean LLM-judge score (0..1) — did the agent answer correctly?
  recall@k      fraction of items where the gold memory was in the injected set
  ctx_tokens    avg injected-context size (~chars/4) — the efficiency cost
  latency_s     avg agent-answer latency

Usage:
  # 1) build a cached dataset of N QA pairs from real memories (one-time, LLM-gen)
  python3 memory_eval.py gen-dataset --n 12 --out datasets/v1.json
  # 2) run the comparison (auto-prints a report; writes results/<tag>/)
  python3 memory_eval.py run --dataset datasets/v1.json --k 5 \
      --strategies none,recency,random,semantic,hybrid,oracle --tag run1
  # 3) re-print a past run's report
  python3 memory_eval.py report --run results/run1

LLM provider defaults to NemoClaw (NVIDIA NIM, Nemotron) since that's the lab's
inference path; override with EVAL_LLM_* env vars. Deterministic-ish: grader runs
at temperature 0. Dataset is cached so strategy comparisons are apples-to-apples.
"""
import argparse
import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"          # memory-mcp-server/.env


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
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")

# LLM provider (agent-under-test + grader). Default: NemoClaw NIM (OpenAI-compatible).
LLM_PROVIDER = os.environ.get("EVAL_LLM_PROVIDER", "nim")
NIM_URL = os.environ.get("EVAL_NIM_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
NIM_KEY = os.environ.get("NVIDIA_API_KEY", "")
AGENT_MODEL = os.environ.get("EVAL_AGENT_MODEL", "nvidia/nemotron-3-super-120b-a12b")
GRADER_MODEL = os.environ.get("EVAL_GRADER_MODEL", "nvidia/nemotron-3-super-120b-a12b")
# Anthropic path (if a valid key is ever set) — EVAL_LLM_PROVIDER=anthropic
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

SB_HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
              "Content-Type": "application/json"}


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# ── low-level clients ─────────────────────────────────────────────────────────
def embed(text: str) -> list:
    r = httpx.post(f"{OLLAMA_URL}/api/embeddings",
                   json={"model": EMBED_MODEL, "prompt": text}, timeout=30)
    r.raise_for_status()
    return r.json()["embedding"]


def sb_get(path: str, params: dict) -> list:
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=SB_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_rpc(fn: str, body: dict) -> list:
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", headers=SB_HEADERS, json=body, timeout=45)
    r.raise_for_status()
    return r.json()


def _strip_reasoning(text: str) -> str:
    # Nemotron/reasoning models may emit <think>…</think> or a reasoning preamble.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    return text.strip()


class LLMRejectedFormat(RuntimeError):
    """The endpoint refused the requested response_format (4xx, not a transport error).

    Separated from a generic failure so grader.py can negotiate DOWN — json_schema
    to json_object to prompt-only — instead of burning all its retries re-sending a
    constraint this endpoint is never going to accept.
    """


def llm(messages: list, model: str, max_tokens: int = 512, temperature: float = 0.2,
        retries: int = 3, response_format: dict | None = None) -> str:
    """One chat completion → assistant text (reasoning stripped).

    response_format (2026-08-07, eval TIER 3) enables constrained decoding for the
    grader. Passing it is what stops a grader model from emitting prose or echoing
    the prompt's placeholders — the failure eval/STATUS.md has been blocked on since
    2026-07-13. Endpoints that do not support it raise LLMRejectedFormat rather than
    retrying, so the caller can fall back a level.
    """
    last = ""
    for attempt in range(retries):
        try:
            if LLM_PROVIDER == "anthropic":
                sys_msg = "".join(m["content"] for m in messages if m["role"] == "system")
                turns = [m for m in messages if m["role"] != "system"]
                body = {"model": model, "max_tokens": max_tokens, "temperature": temperature,
                        "system": sys_msg, "messages": turns}
                # Anthropic has no response_format; the portable equivalent is to
                # prefill the assistant turn with "{" so the reply must continue a
                # JSON object. The "{" is re-attached below since it is consumed.
                prefilled = False
                if response_format is not None:
                    body["messages"] = turns + [{"role": "assistant", "content": "{"}]
                    prefilled = True
                r = httpx.post("https://api.anthropic.com/v1/messages",
                               headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01",
                                        "content-type": "application/json"},
                               json=body, timeout=90)
                if r.status_code == 200:
                    text = _strip_reasoning((r.json().get("content") or [{}])[0].get("text", ""))
                    return ("{" + text) if prefilled and not text.lstrip().startswith("{") else text
                last = f"{r.status_code} {r.text[:160]}"
            else:  # nim / openai-compatible
                body = {"model": model, "max_tokens": max_tokens, "temperature": temperature,
                        "messages": messages}
                if response_format is not None:
                    body["response_format"] = response_format
                r = httpx.post(NIM_URL,
                               headers={"Authorization": f"Bearer {NIM_KEY}", "Content-Type": "application/json"},
                               json=body, timeout=90)
                if r.status_code == 200:
                    return _strip_reasoning(r.json()["choices"][0]["message"]["content"])
                last = f"{r.status_code} {r.text[:160]}"
                if response_format is not None and 400 <= r.status_code < 500:
                    raise LLMRejectedFormat(f"{r.status_code} {r.text[:200]}")
        except LLMRejectedFormat:
            raise
        except Exception as e:
            last = str(e)[:160]
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"LLM call failed after {retries} tries: {last}")


# ── retrieval strategies ──────────────────────────────────────────────────────
FIELDS = "id,name,description,content,type,updated_at"


def _rows_by_ids(ids: list) -> list:
    if not ids:
        return []
    rows = sb_get("memories", {"id": f"in.({','.join(ids)})", "select": FIELDS})
    by_id = {r["id"]: r for r in rows}
    return [by_id[i] for i in ids if i in by_id]  # preserve ranking order


def retrieve(strategy: str, question: str, gold_id: str, k: int) -> list:
    if strategy in ("none",):
        return []
    if strategy == "oracle":
        return _rows_by_ids([gold_id])
    if strategy == "recency":
        return sb_get("memories", {"is_active": "eq.true", "select": FIELDS,
                                    "order": "updated_at.desc", "limit": str(k)})
    if strategy == "random":
        pool = sb_get("memories", {"is_active": "eq.true", "select": "id", "limit": "1000"})
        ids = [r["id"] for r in random.sample(pool, min(k, len(pool)))]
        return _rows_by_ids(ids)
    if strategy in ("semantic", "hybrid"):
        emb = embed(question)
        body = {
            "p_query_text": question if strategy == "hybrid" else " ",  # " " → lexical lanes drop
            "p_query_embedding": json.dumps(emb),
            "p_match_threshold": 0.3,
            "p_match_count": k,
            "p_filter_type": None,
        }
        res = sb_rpc("hybrid_recall", body)
        ids = [r["id"] for r in res][:k]
        return _rows_by_ids(ids)
    die(f"unknown strategy: {strategy}")


def format_context(mems: list) -> str:
    if not mems:
        return ""
    blocks = []
    for m in mems:
        body = (m.get("content") or "").strip()
        blocks.append(f"### {m.get('name','(unnamed)')}\n{m.get('description','')}\n{body}")
    return "\n\n".join(blocks)


# ── agent-under-test + grader ─────────────────────────────────────────────────
AGENT_SYS = (
    "You are an AI agent answering a question from your operator. You have a "
    "memory system; any relevant memories are provided below under MEMORY CONTEXT. "
    "Answer the question directly and concisely using that context when relevant. "
    "If the answer is not supported by your memory or knowledge, say you don't know "
    "rather than guessing. Do not show your reasoning; output only the answer."
)


def agent_answer(question: str, mems: list, model: str) -> str:
    ctx = format_context(mems)
    user = (f"MEMORY CONTEXT:\n{ctx}\n\n---\nQUESTION: {question}"
            if ctx else f"QUESTION: {question}")
    return llm([{"role": "system", "content": AGENT_SYS},
                {"role": "user", "content": user}], model=model, max_tokens=400, temperature=0.2)


GRADER_SYS = (
    "You are a strict grader. Given a QUESTION, the KEY FACTS a correct answer must "
    "contain, and a candidate ANSWER, decide if the answer is correct. It is correct "
    "only if it conveys the key facts (paraphrase is fine) and is not contradicted. "
    "A vague answer, an 'I don't know', or a wrong/hallucinated answer is INCORRECT. "
    "Respond with EXACTLY two lines and nothing else:\n"
    "VERDICT: CORRECT or INCORRECT\nSCORE: a number 0.0 to 1.0"
)


def grade(question: str, key_facts: str, answer: str, model: str) -> dict:
    user = f"QUESTION: {question}\n\nKEY FACTS (must be present):\n{key_facts}\n\nANSWER:\n{answer}"
    out = llm([{"role": "system", "content": GRADER_SYS},
               {"role": "user", "content": user}], model=model, max_tokens=120, temperature=0.0)
    verdict = "CORRECT" if re.search(r"VERDICT:\s*CORRECT", out, re.I) else "INCORRECT"
    m = re.search(r"SCORE:\s*([01](?:\.\d+)?)", out)
    score = float(m.group(1)) if m else (1.0 if verdict == "CORRECT" else 0.0)
    # keep score and verdict consistent
    if verdict == "INCORRECT" and score >= 0.5:
        score = 0.0
    if verdict == "CORRECT" and score < 0.5:
        score = 1.0
    return {"verdict": verdict, "score": score, "raw": out[:200]}


def approx_tokens(mems: list) -> int:
    return len(format_context(mems)) // 4


# ── dataset generation ────────────────────────────────────────────────────────
QA_SYS = (
    "You write evaluation questions for a memory system. Given ONE memory, produce a "
    "single specific question whose answer is contained in that memory's content — the "
    "kind of thing the operator would later ask and expect the agent to recall. Then "
    "list the KEY FACTS the correct answer must contain. The question must be answerable "
    "ONLY from this memory's specifics (names, numbers, causes, decisions), not general "
    "knowledge. Output STRICT JSON: {\"question\": \"...\", \"key_facts\": \"...\"}"
)


def gen_qa(mem: dict, model: str) -> dict:
    body = f"MEMORY NAME: {mem.get('name')}\nDESCRIPTION: {mem.get('description')}\nCONTENT:\n{(mem.get('content') or '')[:2500]}"
    out = llm([{"role": "system", "content": QA_SYS}, {"role": "user", "content": body}],
              model=model, max_tokens=400, temperature=0.3)
    mobj = re.search(r"\{.*\}", out, re.DOTALL)
    if not mobj:
        return None
    try:
        obj = json.loads(mobj.group(0))
    except Exception:
        return None
    if not obj.get("question") or not obj.get("key_facts"):
        return None
    return {"gold_id": mem["id"], "gold_name": mem["name"], "gold_type": mem["type"],
            "question": obj["question"].strip(), "key_facts": obj["key_facts"].strip()}


def cmd_gen_dataset(args):
    # Sample substantive active memories; prefer evergreen (skip tiny/dated-series churn).
    pool = sb_get("memories", {"is_active": "eq.true",
                               "select": "id,name,description,content,type",
                               "order": "created_at.desc", "limit": "1500"})
    # Exclude dated/collapsed log-series (Tech Breakthrough, daily research, weekly-ref,
    # dreaming, …): they're near-duplicates, so retrieval can't disambiguate the gold
    # from its siblings and recall@k is meaningless noise. Keep distinctive/evergreen
    # memories where retrieval SHOULD find the gold — that's where the binding question
    # is real.
    dated = re.compile(r"20\d{2}[-_ ]?\d{2}|\b20\d{6}\b")
    series = ("weekly-ref:", "daily ", "tech breakthrough", "research synthesis",
              "ai memory research", "self-improvement research", "dreaming", "constitution-audit")
    pool = [m for m in pool
            if len((m.get("content") or "")) >= 250
            and not any(s in m["name"].lower() for s in series)
            and not dated.search(m["name"])]
    random.seed(args.seed)
    random.shuffle(pool)
    dataset, tried = [], 0
    for mem in pool:
        if len(dataset) >= args.n:
            break
        tried += 1
        try:
            qa = gen_qa(mem, args.model)
        except Exception as e:
            print(f"  gen failed for {mem['name'][:40]}: {e}")
            continue
        if qa:
            dataset.append(qa)
            print(f"  [{len(dataset)}/{args.n}] {qa['gold_type']:9} {qa['gold_name'][:44]}")
    out = HERE / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"model": args.model, "seed": args.seed, "items": dataset}, indent=2))
    print(f"\nWrote {len(dataset)} QA items ({tried} memories tried) → {out}")


# ── run + report ──────────────────────────────────────────────────────────────
def cmd_run(args):
    ds = json.loads((HERE / args.dataset).read_text())
    items = ds["items"]
    strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
    outdir = HERE / "results" / args.tag
    outdir.mkdir(parents=True, exist_ok=True)
    rows_path = outdir / "rows.jsonl"
    rows_f = rows_path.open("w")

    print(f"Running {len(items)} items × {len(strategies)} strategies "
          f"= {len(items)*len(strategies)} agent+grade pairs (k={args.k})\n")

    def one(item, strat):
        t0 = time.time()
        mems = retrieve(strat, item["question"], item["gold_id"], args.k)
        ans = agent_answer(item["question"], mems, AGENT_MODEL)
        lat = time.time() - t0
        g = grade(item["question"], item["key_facts"], ans, GRADER_MODEL)
        got_gold = any(m["id"] == item["gold_id"] for m in mems)
        return {"gold_id": item["gold_id"], "gold_name": item["gold_name"], "strategy": strat,
                "question": item["question"], "answer": ans, "score": g["score"], "verdict": g["verdict"],
                "recall_gold": got_gold, "ctx_tokens": approx_tokens(mems), "n_injected": len(mems),
                "latency_s": round(lat, 2)}

    results = []
    for i, item in enumerate(items, 1):
        # strategies for one item run in parallel (bounded) — different context, same question
        with ThreadPoolExecutor(max_workers=min(3, len(strategies))) as ex:
            futs = {ex.submit(one, item, s): s for s in strategies}
            per = {}
            for fut in futs:
                s = futs[fut]
                try:
                    per[s] = fut.result()
                except Exception as e:
                    per[s] = {"strategy": s, "gold_id": item["gold_id"], "score": 0.0,
                              "verdict": "ERROR", "recall_gold": False, "ctx_tokens": 0,
                              "n_injected": 0, "latency_s": 0.0, "error": str(e)[:120]}
        line = " ".join(f"{s}={'✓' if per[s].get('score',0)>=0.5 else '✗'}" for s in strategies)
        print(f"  [{i}/{len(items)}] {item['gold_name'][:40]:40}  {line}")
        for s in strategies:
            results.append(per[s])
            rows_f.write(json.dumps(per[s]) + "\n")
    rows_f.close()

    summary = summarize(results, strategies)
    (outdir / "summary.json").write_text(json.dumps(summary, indent=2))
    report = render_report(summary, ds, strategies, args)
    (outdir / "report.md").write_text(report)
    print("\n" + report)
    print(f"\nRows: {rows_path}\nReport: {outdir/'report.md'}")


def summarize(results: list, strategies: list) -> dict:
    out = {}
    for s in strategies:
        rs = [r for r in results if r["strategy"] == s]
        n = len(rs) or 1
        retrievers = s in ("recency", "random", "semantic", "hybrid", "oracle")
        out[s] = {
            "n": len(rs),
            "accuracy": round(sum(r["score"] for r in rs) / n, 3),
            "recall_at_k": (round(sum(1 for r in rs if r["recall_gold"]) / n, 3) if retrievers else None),
            "avg_ctx_tokens": round(sum(r["ctx_tokens"] for r in rs) / n, 1),
            "avg_latency_s": round(sum(r["latency_s"] for r in rs) / n, 2),
            "errors": sum(1 for r in rs if r.get("verdict") == "ERROR"),
        }
    return out


def render_report(summary: dict, ds: dict, strategies: list, args) -> str:
    lines = ["# Memory Injection Eval — report", ""]
    lines.append(f"- dataset: `{args.dataset}` ({len(ds['items'])} items, gen model `{ds.get('model')}`)")
    lines.append(f"- agent: `{AGENT_MODEL}`  ·  grader: `{GRADER_MODEL}`  ·  provider: `{LLM_PROVIDER}`")
    lines.append(f"- retrieval: Ollama `{EMBED_MODEL}` + `hybrid_recall`  ·  k={args.k}")
    lines.append("")
    lines.append("| strategy | accuracy | recall@k | ctx_tokens | latency_s |")
    lines.append("|----------|---------:|---------:|-----------:|----------:|")
    order = [s for s in ["none", "random", "recency", "semantic", "hybrid", "oracle"] if s in strategies]
    for s in order:
        v = summary[s]
        rc = "—" if v["recall_at_k"] is None else f"{v['recall_at_k']:.2f}"
        lines.append(f"| {s} | {v['accuracy']:.2f} | {rc} | {v['avg_ctx_tokens']:.0f} | {v['avg_latency_s']:.1f} |")
    lines.append("")
    # interpretation
    base = summary.get("none", {}).get("accuracy", 0)
    best = max((summary[s]["accuracy"], s) for s in strategies if s != "oracle") if len(strategies) > 1 else (base, "none")
    orc = summary.get("oracle", {}).get("accuracy")
    lines.append("## Read")
    lines.append(f"- **Baseline (none): {base:.2f}** — what the agent answers with no memory injected.")
    lines.append(f"- **Best injection: {best[1]} at {best[0]:.2f}** — lift over baseline = {best[0]-base:+.2f}.")
    if orc is not None:
        lines.append(f"- **Oracle: {orc:.2f}** — ceiling if the exact right memory is always injected. "
                     f"Gap from best→oracle ({orc-best[0]:+.2f}) is the *retrieval* headroom; "
                     f"gap from oracle→1.0 is the *agent/answer* headroom.")
    sem = summary.get("semantic", {}).get("recall_at_k")
    hyb = summary.get("hybrid", {}).get("recall_at_k")
    if sem is not None or hyb is not None:
        lines.append(f"- **recall@k** (gold memory actually injected): "
                     f"semantic={sem if sem is not None else '—'}, hybrid={hyb if hyb is not None else '—'} "
                     f"— low recall@k caps accuracy no matter how good the agent is.")
    return "\n".join(lines)


def cmd_report(args):
    outdir = HERE / args.run if not str(args.run).startswith("/") else Path(args.run)
    summary = json.loads((outdir / "summary.json").read_text())
    print((outdir / "report.md").read_text())


def main():
    ap = argparse.ArgumentParser(description="Memory injection eval harness")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gen-dataset", help="generate a cached QA dataset from live memories")
    g.add_argument("--n", type=int, default=12)
    g.add_argument("--out", default="datasets/v1.json")
    g.add_argument("--seed", type=int, default=7)
    g.add_argument("--model", default=GRADER_MODEL)
    g.set_defaults(func=cmd_gen_dataset)

    r = sub.add_parser("run", help="run strategy comparison over a dataset")
    r.add_argument("--dataset", default="datasets/v1.json")
    r.add_argument("--k", type=int, default=5)
    r.add_argument("--strategies", default="none,recency,random,semantic,hybrid,oracle")
    r.add_argument("--tag", default="run1")
    r.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="re-print a past run's report")
    p.add_argument("--run", default="results/run1")
    p.set_defaults(func=cmd_report)

    args = ap.parse_args()
    if not SUPABASE_URL or not SUPABASE_KEY:
        die("SUPABASE_URL / SUPABASE_SECRET_KEY not found (expected in ../.env)")
    args.func(args)


if __name__ == "__main__":
    main()
