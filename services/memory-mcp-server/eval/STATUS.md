# Memory-Injection Evaluation — Project Status

**One-liner:** measure whether *injecting* relevant memory into an agent's context makes
it answer/act better than on-demand recall or nothing — and separate *retrieval* headroom
from *binding* headroom (how well the agent uses memory it's given). This is the
measurement arm of the "make Claude an active participant in its memory" thread.

> **Start here.** A new session should read THIS file (+ `recall "memory injection eval"`)
> to get oriented in a few K tokens instead of re-reading a long conversation. Update the
> "Current state" and "Next steps" sections as work lands — this is the living index.

## Where it lives (the map)
| concern | home |
|---|---|
| Code + datasets | `~/azlab/services/memory-mcp-server/eval/` (repo `aeger/az-lab`, branch `beta`) |
| This status / next steps | `eval/STATUS.md` (this file) — the single entry point |
| Vision & milestones | Supabase `goals` milestone **`8f156f3c-3aa7-40c8-82e5-4f5987624aa0`** under strategy *State-of-the-art memory architecture* (`…010`) — auto-loaded at every session start |
| Actionable issues (agent work) | Supabase `task_queue` — escalate a specific next-step here when you want an agent to run it (note: pollers execute + bill, so queue deliberately) |
| Run results / observability | `eval/results/<tag>/report.md` + `rows.jsonl` (gitignored — ephemeral); headline numbers logged in "Run log" below |
| Durable context for resume | memories `memory-injection-eval-harness-20260713`, `memory-md-churn-root-cause-slug-collision-20260712` |

## Components
- `memory_eval.py` — generic QA over injection **strategies** (none/recency/random/semantic/hybrid/oracle). Metrics: accuracy, recall@k, ctx_tokens, latency.
- `scenario_eval.py` + `scenarios/*.json` — realistic **incident** scenarios across knowledge **substrates** (blind / well-documented-homelab / az-lab memory). Rubric-graded vs a gold fix, with replicates.
- `retrieval_regression.py` — the nightly **retrieval** gate (separate concern from injection: zero LLM calls, seconds not minutes). `run` / `gate` / `trend` / `sweep` / `router`.
- `falsify_fcfr.py` — **run this before trusting any FCFR number.** `--audit-only` reports how many probes declare a *reachable* forbidden id; the full run forces a violation through `score()` to prove the metric is wired. Written 2026-07-30 after FCFR read exactly 0 on six consecutive runs: the metric was wired, but 8 of 9 probes pointed only at `is_active=false` rows that `hybrid_recall` filters on every lane, so they could not fail. A metric that cannot fail is not a passing metric.
- Retrieval = the real path: Ollama `nomic-embed-text` (768d) + `hybrid_recall` RPC.
- LLM (agent+grader) = NemoClaw (NVIDIA NIM, Nemotron 120B). `EVAL_LLM_PROVIDER=anthropic` supported once a valid key exists (the one in `../.env` is 401).

## Retrieval-gate state (2026-07-30, migration 091)
- Probe set is **scoreset v2**: 79 positive + 11 with forbidden ids (88 active rows). `cmd_gate` medians only over runs sharing `scoreset_version`, so changing the probe set cannot fire an unattributable regression alert — bump the constant in `retrieval_regression.py` whenever you add or retire probes.
- Headline: Recall@5 **0.835**, nDCG@10 **0.701**, Δ-over-no-memory **+0.686**, FCFR-live **0.500** (2 scorable probes).
- The old 56 probes still score **1.00 in every category** while the 21 adversarial paraphrases score **9/21** — same golds, no shared distinctive tokens. Read that as label leakage in the original set, not as a ranker regression.
- Adding probes is the lever that keeps this instrument alive. Write them as the SYMPTOM in the words someone hitting it would use, and check the wording against the gold for shared distinctive tokens before committing.

## Current state (2026-07-13)
- ✅ Both harnesses built, committed (az-lab beta `d1fea02`, `b3b6a57`).
- ✅ QA harness first read: injection lifts accuracy **0.00 → 0.60**; oracle=0.60 (binding gap visible). N=5, noisy.
- ⚠️ Scenario harness runs, but **results not yet trustworthy** — see findings.

## Findings so far (what the runs actually taught us)
1. **Grader reliability is the #1 blocker.** Nemotron is an unreliable structured grader — scores clearly-correct answers near zero, echoes template placeholders. Fix before trusting any number.
2. **Retrieval is brittle to query framing.** A user report phrased "…on Home Assistant" steered `hybrid_recall` to HA memories; the relevant in-store memory (`homebridge-host-location`) never surfaced even at k=12.
3. **Best experiential memory is local-only.** `homebridge-alexa-cookie-expiry-fix` isn't in the queryable store (governance-blocked from Supabase) — the "memory" condition structurally can't reach it. The good stuff lives in the bootstrap layer, not the queryable one.
4. **For semi-common problems, blind/docs can match memory.** Memory's edge is largest on lab-specific, non-obvious, previously-solved incidents — pick scenarios accordingly.

## Next steps (priority order — check off as done)
- [ ] **Fix the grader** (biggest lever): constrained output, a different/stronger grader model, or keyword-anchored scoring vs the gold; human spot-check to calibrate.
- [ ] **Make the memory condition fair**: get the fix memory into the queryable store, or add a "local-bootstrap" memory condition, so the pipeline actually has the answer.
- [ ] **Add lab-specific scenarios** where the fix is genuinely un-guessable (that's where memory should decisively win).
- [ ] **Add an "ambient" strategy** to `memory_eval.py` (memory pushed every turn) vs on-demand recall — the original research question: does ambient injection close the oracle→1.0 binding gap?
- [ ] **Observability**: append each run's headline numbers to the Run log below (and later a dashboard widget on home.az-lab.dev).

## Run log
| date | harness | tag | headline |
|---|---|---|---|
| 2026-07-13 | memory_eval | v1 | none 0.00 · semantic 0.60 · hybrid 0.20 · oracle 0.60 (N=5) |
| 2026-07-13 | scenario_eval | hb1/hb2 | grader unreliable → scores void; retrieval missed gold |
| 2026-07-24 | retrieval_regression | baseline-ndcg-20260724 | N=56 · recall@5 0.500 · recall@10 0.643 · MRR 0.327 · **nDCG@10 0.374** |

## 2026-07-24 update (research rec 2 — close the retrieval-gate gap)
- **nDCG@5/@10 added** to `retrieval_regression.py` (migration 072). recall@k is blind to
  rank inside k and MRR only credits the best hit; nDCG catches order-only regressions
  (gold demoted but still top-k). `--compare` now trips on recall@5 **or** nDCG@10 slipping.
- **Probe set 38 → 56.** `build_probes.py` mines high-`recall_count` memories (the rows the
  fleet actually leans on) into category `mined_high_recall`, filtered to distinctive,
  non-dated, unique-question facts so the gate stays discriminating (mined recall@5 0.56 ≈
  curated single_hop 0.45 — not trivially easy). Reported per-category so mined can never
  mask a curated regression.
- Baseline recorded above — the number future RRF/trust/A-MAC weight changes must hold.

## How to run
```bash
cd ~/azlab/services/memory-mcp-server/eval
python3 memory_eval.py gen-dataset --n 30 --out datasets/v2.json && python3 memory_eval.py run --dataset datasets/v2.json --tag v2
python3 scenario_eval.py run --scenario scenarios/homebridge_alexa.json --tag hb3
```
