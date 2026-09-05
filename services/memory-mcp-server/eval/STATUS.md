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
- `grader.py` — the **scoring layer** for `scenario_eval.py`, and the reason its numbers can now be believed. Two independent scorers: `grade_llm()` (structured decoding, negotiated down `json_schema`→`json_object`→prompt-only, balanced-brace JSON extraction) and `grade_anchored()` (deterministic clause matching against gold-derived anchors — no LLM, free, reproducible). Every grade carries a `GradeStatus`; an unparseable or template-echoing grade is **INVALID and excluded**, never recorded as 0. `aggregate()` returns `mean_score: None` and `void: true` rather than averaging garbage. `python3 grader.py calibrate` checks both scorers against hand-banded fixtures — **run it before trusting any scenario run.**
- `falsify_fcfr.py` — **run this before trusting any FCFR number.** `--audit-only` reports how many probes declare a *reachable* forbidden id; the full run forces a violation through `score()` to prove the metric is wired. Written 2026-07-30 after FCFR read exactly 0 on six consecutive runs: the metric was wired, but 8 of 9 probes pointed only at `is_active=false` rows that `hybrid_recall` filters on every lane, so they could not fail. A metric that cannot fail is not a passing metric.
- `falsify_idf_knob.py` — **run this before trusting any `recall_weights` A/B.** Same discipline as `falsify_fcfr.py`, applied to a tuning knob instead of a metric. Phase 1 recomputes the live tilt arithmetic per probe (no retrieval); phase 2 flips `idf_adaptive_enabled` on for real and diffs the *returned id lists* across off / on@lo / on@hi; phase 3 renders a verdict. It mutates exactly one `recall_weights` row and restores it in a `finally`, takes the eval lock, and deliberately does NOT write `eval_runs` (a diagnostic in the trend series would poison the gate median).
- Retrieval = the real path: Ollama `nomic-embed-text` (768d) + `hybrid_recall` RPC.
- LLM (agent+grader) = NemoClaw (NVIDIA NIM, Nemotron 120B). `EVAL_LLM_PROVIDER=anthropic` supported once a valid key exists (the one in `../.env` is 401).

## Retrieval-gate state (2026-07-30, migration 091)
- Probe set is **scoreset v2**: 79 positive + 11 with forbidden ids (88 active rows). `cmd_gate` medians only over runs sharing `scoreset_version`, so changing the probe set cannot fire an unattributable regression alert — bump the constant in `retrieval_regression.py` whenever you add or retire probes.
- Headline: Recall@5 **0.835**, nDCG@10 **0.701**, Δ-over-no-memory **+0.686**, FCFR-live **0.500** (2 scorable probes).
- The old 56 probes still score **1.00 in every category** while the 21 adversarial paraphrases score **9/21** — same golds, no shared distinctive tokens. Read that as label leakage in the original set, not as a ranker regression.
- Adding probes is the lever that keeps this instrument alive. Write them as the SYMPTOM in the words someone hitting it would use, and check the wording against the gold for shared distinctive tokens before committing.

## IDF-adaptive knob — WIRED AND SENSITIVE, 07-31 A/B retracted (2026-08-11)
The 2026-07-31 A/B recorded strength **0.5** and **1.2** with bit-identical MRR
`0.688185654008439` and nDCG `0.702632792830539` — to 15 decimals, over 79 probes — and
concluded the tilt was inside noise and shipped it OFF. **That result is retracted.**
`falsify_idf_knob.py` over the current 118 active probes
(raw output: `eval/results/falsify_idf_knob_20260811.txt`, gitignored) found:

| phase | result |
|---|---|
| 1 — arithmetic | effective lane weights differ at 0.5 vs 1.2 on **118/118** probes; **0** saturate the ±0.9 clamp; largest single-lane gap **0.442** |
| 2 — ranking (flag actually ON) | off vs on@0.5 → **75/118** id lists changed; off vs on@1.2 → **100/118**; on@0.5 vs on@1.2 → **75/118** |
| 2 — rank 1 only | **0**, **2** and **2** probes respectively |
| 3 — verdict | **WIRED AND SENSITIVE** — not dead code |

The knob reaches the arithmetic and it moves rankings. Rank 1 barely budges, which is why
rank-1-weighted aggregates look flat — but 75 differing id lists cannot produce identical
nDCG@10 to 15 decimals. So the 07-31 collision was a **harness fault**, not a property of
the ranker: both arms almost certainly ran with `idf_adaptive_enabled=false`, i.e. the
treatment was never applied. Note the tempting wrong reading — "the flag is off live, so
of course the floats matched" — is also refuted by phase 2; the question is what the A/B
*did*, not what the live row says now.

`idf_adaptive_enabled` stays **OFF**: it is UNMEASURED, not measured-and-inert. Two rules
follow for any future `recall_weights` A/B:
1. Assert the flag is actually `true` **inside** the treatment arm and read it back.
2. Diff returned id lists, not summary floats. Aggregates collide; lists don't.

## Bi-temporal read path — WIRED AND SENSITIVE (2026-08-11)
Migration 109 gave `hybrid_recall` a `p_as_of` parameter and a
`valid_from <= T AND (valid_to IS NULL OR valid_to > T)` predicate at all 14 `is_active`
sites. Its gate (`pre-mig109` / `post-mig109`) came back **bit-identical to 15 decimals** —
which is the pattern `falsify_idf_knob.py` was written to distrust, so it was checked rather
than assumed. The state of the store explains the tie and does not excuse it:

| check | value |
|---|---|
| memories with `valid_to` closed | **150** / 1041 |
| of those, also `superseded_by IS NOT NULL` | **150** (all) |
| closed interval but still `is_active` | **0** |
| `valid_from` in the future | **0** |

Every closed interval today belongs to a row `is_active` already excluded, so the new
predicate is exactly redundant on current data. The identical gate therefore proves the
filter is **inert on the probe set**, NOT that it is correct — a distinction the run log now
states outright.

Time travel itself was then falsified directly, diffing **returned id lists** rather than
summary floats (the 07-31 lesson). Query `'Daily Self-Improvement Research 2026-07-10'`,
`p_match_count 20`, lexical lanes:

| arm | result |
|---|---|
| `p_as_of` NULL (now) | target `eb51e87d…` **absent** |
| `p_as_of` `2026-08-01` (before its `valid_to`) | target **present** |
| rows re-admitted by the as-of arm | **7** |

So the parameter reaches the query plan and changes what comes back: **wired and sensitive.**
The remaining untested case is the one that motivated the migration — a row whose validity
ended while the row stayed active (`n_closed_but_active = 0` today, so it cannot yet occur).
Until a writer other than `supersede_memory()` sets `valid_to`, that path is unexercised;
see next steps.

## Current state (2026-08-11)
- ✅ Both harnesses built, committed (az-lab beta `d1fea02`, `b3b6a57`).
- ✅ QA harness first read: injection lifts accuracy **0.00 → 0.60**; oracle=0.60 (binding gap visible). N=5, noisy.
- ✅ Scenario harness results are now **trustworthy** — the grader blocker is closed, see below.

### Grader blocker CLOSED (2026-08-11 re-verified; fix landed 2026-08-07)
Finding 1 below — "grader reliability is the #1 blocker", open since 2026-07-13 — is
resolved and **measured**, not asserted. `grader.py` replaced the per-dimension regex whose
`int(matches[-1]) if matches else 0` recorded a grade that FAILED TO PARSE as a grade of
**zero**, indistinguishable downstream from a genuinely wrong answer. That parser, not the
model, is why "clearly-correct answers scored near zero": they largely did not score at all.

Both scorers now calibrate clean against the five hand-banded fixtures in
`fixtures/homebridge_alexa_cookie_grader.json` (raw: `results/grader_calibration_20260811.txt`):

| fixture | band | anchored | llm (2 reps) |
|---|---|---|---|
| gold_verbatim | 0.85–1.00 | 1.00 | 1.00, 1.00 |
| strong_paraphrase | 0.70–1.00 | 0.88 | 1.00, 1.00 |
| generic_reauth | 0.05–0.50 | 0.12 | 0.38, 0.38 |
| wrong_ha_chase | 0.00–0.30 | 0.00 | 0.12, 0.12 |
| empty_refusal | 0.00–0.15 | 0.00 | 0.12, 0.12 |

**anchored 5/5 · llm 5/5 · llm grades that parsed at all 10/10.** The 10/10 parse rate is
the number that retires the blocker: the original symptom was template-placeholder echo, and
under structured decoding it now occurs zero times in ten calls. Note the LLM arm is
consistently *more generous* at the bottom of the scale (0.12 where anchored gives 0.00) —
it stays inside the bands, but prefer the anchored score when the two disagree, since it
needs no model and so survives whatever the grader model does next quarter.

Re-run before trusting any scenario number:
`python3 grader.py calibrate` (add `--anchored-only` for the free, no-API arm).

## Supersession consolidation — MEASURED 0.000, question closed (2026-08-13)

`retrieval_regression.py consolidation` — the az-lab analogue of MemoryAgentBench
FactConsolidation (arXiv 2507.05257). MemStrata (arXiv 2606.26511) reports undefended RAG
serving superseded values **15–40%** of the time; we had no number at all.

Constructive, not observational: each case asserts a fact, asserts its replacement, calls
`supersede_memory`, then asks for the fact back. Unlike FCFR it does not depend on what the
corpus happens to have retired, so its denominator cannot silently drain.

**Result — 0/20 armed pairs, twice (`full1`, `full2`), rate 0.000.** Raw:
`results/consolidation/20260813-full{1,2}.json`.

| layer | leaked | what it covers |
|---|---|---|
| `ranker` | 0/5 | `hybrid_recall` RPC alone — the control; confirms the `is_active` predicate is wired |
| `recall/hybrid` | 0/5 | full MCP tool: staleness haircut, rerank, spreading activation, linked-memories section |
| `recall/lexical` | 0/5 | BM25/trigram lane, exact-token query |
| `recall/agent` | 0/5 | same, read by a **third** agent that wrote neither row |

5 cases: same-agent, iris-over-wren, atlas-over-iris, a linked entry point (edge at strength
0.95, above `SPREAD_ACTIVATION_THRESHOLD`), and a private/agent-scoped row. **3 of 5 are
cross-agent** — three agents share one pool, so the agent that retires a row is usually not
the one that wrote it.

**The number is only worth anything because of the positive control.** Every (case, layer)
pair is probed on BOTH sides of the supersede. All 20 returned the value *before* it and
none after; a pair that fails the pre-check is `unarmed` and leaves the denominator, so a
"clean 0" produced by a probe that stopped working reports as `armed 0/20`, not as a pass.
This is the lesson from FCFR reading 0.0000 for six runs over an unreachable denominator.
`path=spread` appears in the layer table, so spreading activation — the layer FCFR
structurally cannot see — really was exercised.

**Scope, and what 0.000 does NOT mean.** Supersession here is *agent-invoked*, not derived
from a `(subject, relation, object)` key: nothing forces mutual exclusion between two live
rows asserting the same `(subject, relation)`. This probe measures only whether an **invoked**
supersession is airtight. It says nothing about pairs where no agent ever called
`supersede_memory` — that population is invisible to it by construction. Deriving the key
vs keeping it agent-invoked is a **separate design call**, deliberately not taken here.

**One adjacent exposure, on the record but not in the rate.** The recall tool's keyword
FALLBACK path filters bi-temporally but has never filtered `is_active` (noted in
`src/index.ts`). `supersede_memory` always stamps `valid_to`, so nothing it retires is
reachable there — but **44 of 194 retired rows have `valid_to` NULL** (retired by some other
path) and are. The probe prints this census every run.

Not wired into the nightly: it writes to the live corpus. It takes the same `eval_lock` and
access-stat snapshot as `run` and hard-deletes in a `finally`; `consolidation --cleanup-only`
sweeps orphans. Verified after both runs: 0 leftover rows, 0 orphan links, corpus counts
unchanged.

**No fixture contention with the forgetting-probe work.** This probe seeds and deletes its
own rows within a single run and never touches the `eval_queries` table. The flip side is
that it adds **no** FCFR denominator headroom — an `eval_queries` forgetting probe needs a
*persistent* `forbidden_memory_ids` target, and these rows are gone by the time the run ends.

## Findings so far (what the runs actually taught us)
1. ~~**Grader reliability is the #1 blocker.**~~ **CLOSED 2026-08-11** — see "Grader blocker CLOSED" above. The root cause was the harness parser encoding a parse failure as a score of 0, not the model. Kept here because the *lesson* generalises: a scoring path that maps "I could not read this" onto the worst legal score will manufacture a confident wrong number every time.
2. **Retrieval is brittle to query framing.** A user report phrased "…on Home Assistant" steered `hybrid_recall` to HA memories; the relevant in-store memory (`homebridge-host-location`) never surfaced even at k=12.
3. **Best experiential memory is local-only.** `homebridge-alexa-cookie-expiry-fix` isn't in the queryable store (governance-blocked from Supabase) — the "memory" condition structurally can't reach it. The good stuff lives in the bootstrap layer, not the queryable one.
4. **For semi-common problems, blind/docs can match memory.** Memory's edge is largest on lab-specific, non-obvious, previously-solved incidents — pick scenarios accordingly.

## Next steps (priority order — check off as done)
- [x] **Fix the grader** (biggest lever) — done 2026-08-07, re-verified 2026-08-11. Landed all three suggested routes: constrained/structured decoding (negotiated `json_schema`→`json_object`→prompt-only), keyword-anchored LLM-free scoring vs the gold, and hand-banded fixtures for calibration. Invalid grades are now excluded and counted rather than averaged as 0, and a run whose invalid fraction exceeds `EVAL_MAX_INVALID_GRADES` (default 0.20) reports **VOID** instead of a confident number.
- [ ] **Add an as-of probe to the retrieval gate.** Today `retrieval_regression.py` only ever calls `hybrid_recall` with `p_as_of` NULL, so a regression that broke time travel would not fire. Needs a probe asserting the two arms return *different id lists* for a known superseded row (the check run by hand on 2026-08-11 above), plus the still-unexercised case: a row with `valid_to` set and `is_active` left true. That second one requires a writer other than `supersede_memory()` — an expiring lease/cert is the natural first one.
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
| 2026-08-07 | rerank_ab | rerank_ab_int8_20260807 | N=97 · fp32 nDCG@5 0.7470 / recall@5 0.8351 / MRR 0.7650 / p50 4587ms · int8 nDCG@5 0.7370 / recall@5 0.8454 / MRR 0.7486 / p50 1517ms → **-1.3% rel nDCG@5 for 3.0x lower p50, better recall@5** |
| 2026-08-07 | retrieval_regression | pre-mig109 / post-mig109 | bi-temporal read-path gate (TIER 1): N=97 · recall@5 **0.8144 → 0.8144** · nDCG@10 **0.6766 → 0.6766** · nDCG@5 0.6667 → 0.6667 → **PASS, bit-identical**. Expected: with `p_as_of` NULL and no probe memory carrying a closed `valid_to`, the new predicate admits exactly the old row set — the gate proves the filter is inert on current data, *not* that time travel works (that needs an as-of probe, see next steps). |
| 2026-08-08 | retrieval_regression | int8-verify-20260808 | post-cutover gate on the live path (`RERANKER_URL` → `rerank-onnx`, INT8): N=97 · **nDCG@10 0.6769** vs trailing-7 median 0.6766 (delta +0.0%, floor 0.6427) · FCFR 0.000 → **PASS, no ranking regression** |
| 2026-08-11 | grader calibrate | grader_calibration_20260811 | homebridge_alexa_cookie, Nemotron 120B, 2 reps × 5 fixtures: anchored **5/5**, llm **5/5**, llm parse rate **10/10** → **grader blocker CLOSED** |

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
