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
- Retrieval = the real path: Ollama `nomic-embed-text` (768d) + `hybrid_recall` RPC.
- LLM (agent+grader) = NemoClaw (NVIDIA NIM, Nemotron 120B). `EVAL_LLM_PROVIDER=anthropic` supported once a valid key exists (the one in `../.env` is 401).

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

## How to run
```bash
cd ~/azlab/services/memory-mcp-server/eval
python3 memory_eval.py gen-dataset --n 30 --out datasets/v2.json && python3 memory_eval.py run --dataset datasets/v2.json --tag v2
python3 scenario_eval.py run --scenario scenarios/homebridge_alexa.json --tag hb3
```
