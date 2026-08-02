-- 103_distractor_carry_forward_columns.sql
-- 2026-08-02 daily research REC 2, follow-up fix.
--
-- ============================================================================
-- WHY — the harness was writing two columns that did not exist
-- ============================================================================
-- 101 gave every hard-tier probe a forbidden_memory_ids set so that OVER-retrieval
-- is scored, not just retrieval. retrieval_regression.py splits those forbidden-id
-- hits into two populations, and the split is the whole point:
--
--   n_forgetting / false_carry_forward_rate — SUPERSESSION failures. A retired fact
--       reached the top-10, so an agent can answer from something that is no longer
--       true. Ceiling is 0.0 and gated as such (--max-fcfr).
--   n_distractor / distractor_rate — NEAR-DUPLICATE failures. The forbidden row is
--       still perfectly current, it just is not the answer to THIS question. This
--       one is NOT gated directly: a distractor outranking gold already shows up in
--       hard_recall_at_1, and a 0.0 ceiling here would be unreachable by
--       construction, because a distractor probe is only interesting when the
--       distractor is competitive.
--
-- cmd_run posts the metrics dict to eval_runs with `**m`, so the two new keys went
-- into the INSERT payload — against a table that had no such columns. PostgREST
-- answered 400 and the run died AFTER scoring all 118 probes but BEFORE persisting
-- any of them. Reproduced 2026-08-02: tag=hardtier-baseline-21 scored clean, then
-- threw HTTPStatusError on POST /eval_runs. The 05:00 nightly would have done the
-- same and left only a traceback in eval_nightly.log.
--
-- The 16:46 hardtier-v4-check run predates the distractor split, which is why it
-- persisted fine and hid this until the next run.
--
-- Nullable on purpose, matching hard_* in 102: NULL means "this run had no
-- distractor probes", 0.0 means "it had them and none carried forward". Collapsing
-- those two into 0.0 is how 096 ended up gating on a one-probe tier.

alter table public.eval_runs
  add column if not exists n_distractor    integer,
  add column if not exists distractor_rate double precision;

comment on column public.eval_runs.n_distractor is
  'Number of probes carrying forbidden_memory_ids that are near-duplicate DISTRACTORS (still-current rows that are not the answer), as opposed to superseded facts. Disjoint from n_forgetting. NULL when the run predates the 101 hard tier.';
comment on column public.eval_runs.distractor_rate is
  'Fraction of distractor probes that returned a forbidden near-duplicate in the top-10. Diagnostic, NOT gated: the same failure is already penalised by hard_recall_at_1 (the distractor pushes gold off rank 1), and a 0.0 ceiling would be unreachable since a useful distractor is by design competitive. NULL when n_distractor is 0.';
