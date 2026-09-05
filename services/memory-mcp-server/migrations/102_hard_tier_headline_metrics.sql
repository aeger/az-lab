-- 102_hard_tier_headline_metrics.sql
-- 2026-08-02 daily research REC 2, second half: move the gate onto a metric
-- that can move, restricted to the tier that can move it.
--
-- NOTE (recovered 2026-08-02): this migration was APPLIED to the database before
-- its file was committed, so for several hours the DB head (102) was ahead of the
-- repo (101) — the exact divergence [[migration-ledger-is-truth-not-the-migrations-dir]]
-- warns about, just in the opposite direction from the usual failure. The body below
-- is recovered verbatim from supabase_migrations.schema_migrations.statements.
--
-- 096 established that recall@5 is INSENSITIVE on this scoreset — bit-identical to
-- fifteen decimals across six consecutive runs, including the deliberate A/B control
-- and both treatment arms — because every change so far reorders documents already
-- inside the top 5. It added hard_recall_at_5 / hard_ndcg_at_10, but the sensitive
-- pair (recall@1, nDCG@5) was only ever computed corpus-wide, never for the hard tier.
-- With 101 taking the tier from 3 probes to 21, the hard-tier versions are now the
-- numbers worth gating on: a near-duplicate distractor probe fails by putting the
-- sibling at rank 1, which recall@5 cannot see and recall@1 registers immediately.

alter table public.eval_runs
  add column if not exists hard_recall_at_1 double precision,
  add column if not exists hard_ndcg_at_5   double precision;

comment on column public.eval_runs.hard_recall_at_1 is
  'recall@1 over tier=hard probes only. THE gate metric as of 2026-08-02: the hard tier is built from near-duplicate distractor clusters, where the characteristic failure is the sibling row taking rank 1 — invisible to recall@5, immediate in recall@1. NULL (not 0.0) when the tier is empty, so \"not measured\" and \"measured, failed\" never print the same.';
comment on column public.eval_runs.hard_ndcg_at_5 is
  'nDCG@5 over tier=hard probes only. Companion to hard_recall_at_1: rewards partial credit on the multi-hop probes whose gold set has two rows, where a binary hit metric scores 1.0 for finding half the answer.';
