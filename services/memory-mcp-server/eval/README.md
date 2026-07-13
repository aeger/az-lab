# Memory Injection Eval Harness

Measures the research question we care about: **does injecting relevant memory into
an agent's context actually make it answer better** — vs. making it pull on demand,
vs. nothing? The store + retrieval are largely solved; the open problem is *binding*
(how well/reliably an agent turns memory into a correct action). This harness turns
that into a number you can move.

## What it does

1. **Auto-builds a dataset** of QA pairs from the *live* memory store: for each
   sampled memory it asks the LLM to write a question whose answer lives in that
   memory, plus the key facts a correct answer must contain. The source memory id is
   recorded as the **gold** memory, so we can measure retrieval too.
2. **Runs each question under several injection strategies** (the independent
   variable), using the system's **real** retrieval path (Ollama `nomic-embed-text`
   + the `hybrid_recall` RPC — same as the MCP `recall` tool):

   | strategy | what's injected |
   |----------|-----------------|
   | `none`     | nothing (baseline — parametric answer) |
   | `recency`  | K most-recently-updated memories (naive default) |
   | `random`   | K random memories (control) |
   | `semantic` | `hybrid_recall`, vector-only |
   | `hybrid`   | `hybrid_recall`, BM25 + vector (system default) |
   | `oracle`   | the gold memory (upper bound) |

3. **Grades** each answer with an LLM judge (temp 0) against the key facts, and
   reports per-strategy **accuracy**, **recall@k** (was the gold memory injected),
   **context tokens**, and **latency**.

## Reading the result

- `none` = how much the agent already "knows" without memory.
- best injection − `none` = **the value of injecting memory at all**.
- `oracle` = ceiling with perfect retrieval. `oracle − best` = **retrieval headroom**
  (fix retrieval); `1.0 − oracle` = **agent/answer headroom** (fix how the agent uses
  what it's given — the "binding" problem).
- `recall@k` low ⇒ accuracy is capped by retrieval, not the model.

This is how you tell whether the next improvement should go into *retrieval* or into
*how memory is presented/bound* — the whole point of the research thread.

## Usage

```bash
cd ~/azlab/services/memory-mcp-server/eval
# 1) build a cached dataset (LLM-generated; one-time, reproducible via --seed)
python3 memory_eval.py gen-dataset --n 12 --out datasets/v1.json
# 2) run the comparison (prints a report; writes results/<tag>/)
python3 memory_eval.py run --dataset datasets/v1.json --k 5 --tag run1
# 3) re-print a past report
python3 memory_eval.py report --run results/run1
```

## Cost / config

Every item makes `strategies × 2` LLM calls (agent + grader). A 12-item × 6-strategy
run ≈ **156 LLM calls**. Default provider is **NemoClaw (NVIDIA NIM, Nemotron 120B)** —
mind the NIM quota. Override via env:

- `EVAL_LLM_PROVIDER` = `nim` (default) or `anthropic`
- `EVAL_AGENT_MODEL`, `EVAL_GRADER_MODEL`
- `EVAL_NIM_URL`, `NVIDIA_API_KEY` (NIM) / `ANTHROPIC_API_KEY` (anthropic)
- `OLLAMA_URL_HOST` (default `http://localhost:11434`), `EMBED_MODEL` (`nomic-embed-text`)

Creds are read from `../.env` (the memory-mcp-server env). Start small (`--n 4`,
`--strategies none,hybrid,oracle`) to sanity-check before a full run.

## Extending

- New strategy → add a branch in `retrieve()` (e.g. PageRank-weighted, MMR-diversified,
  rerank-on, summarized-injection). The harness measures it for free.
- Swap the agent model to test whether a weaker/stronger model changes the *value* of
  injection (the binding question is model-dependent).
- Larger/hand-curated datasets → drop a JSON with the same `{items:[{gold_id, question,
  key_facts, ...}]}` shape into `datasets/`.
