-- Migration 079: backfill ndcg_at_5 / ndcg_at_10 for the two pre-072 eval runs
-- Ref: 2026-07-28 daily research, tier 1 (nightly retrieval eval + regression gate)
--
-- PROBLEM
--   nDCG landed in migration 072 (2026-07-24). The two 2026-07-23 baselines
--   (baseline-post-065, baseline-nonmutating) predate it, so eval_runs.ndcg_at_10
--   is NULL for them. The nightly gate medians over the trailing N runs on
--   ndcg_at_10 — NULL rows are silently skipped, so the trend line starts with a
--   two-run hole and the median has less history than it appears to.
--
-- WHY THIS IS RECOMPUTABLE AND NOT A GUESS
--   eval_run_results.returned_ids stores the FULL ranked id list hybrid_recall
--   returned for every query in those runs, and eval_queries.gold_memory_ids still
--   holds the same gold. nDCG here is binary-relevance and position-only, so it is a
--   pure function of (returned_ids, gold) — replaying it reproduces exactly what
--   072's Python would have computed at the time. No re-retrieval, no drift.
--
--   Binary nDCG@c (mirrors ndcg_at() in eval/retrieval_regression.py):
--     DCG  = sum over positions i (1-indexed, i<=c) of 1/log2(i+1) where returned[i] in gold
--     IDCG = sum over i=1..min(|gold|, c) of 1/log2(i+1)
--
-- CAVEAT
--   Both runs are n=38 (the curated seed) vs 56 today (curated + mined_high_recall).
--   The metric is normalised per query and averaged, so it is comparable in kind, but
--   the probe SETS differ — a small level shift between 07-23 and 07-24 is expected
--   and is not a regression. Left in place deliberately: a gate that medians over a
--   longer, honest history beats one with a hole in it.

BEGIN;

-- Every (run, query) pair belonging to a run that still lacks a run-level nDCG.
-- Driven off eval_runs, not eval_run_results, so that a query whose returned_ids is
-- EMPTY (retrieval failed at the time) still gets a row here and scores 0 — the
-- Python counts a failed retrieval as a miss, it does not drop it from the
-- denominator. A LEFT JOIN LATERAL is what keeps those rows alive.
CREATE TEMP TABLE _ndcg_backfill ON COMMIT DROP AS
WITH target_runs AS (
  SELECT id FROM eval_runs WHERE ndcg_at_10 IS NULL
),
expanded AS (
  SELECT r.run_id, r.query_id, u.mid, u.pos
  FROM eval_run_results r
  JOIN target_runs t ON t.id = r.run_id
  LEFT JOIN LATERAL unnest(r.returned_ids) WITH ORDINALITY AS u(mid, pos) ON true
),
per_query AS (
  SELECT e.run_id,
         e.query_id,
         COALESCE(SUM(1.0 / log(2.0, (e.pos + 1)::numeric))
                  FILTER (WHERE e.mid = ANY(q.gold_memory_ids) AND e.pos <= 5), 0) AS dcg5,
         COALESCE(SUM(1.0 / log(2.0, (e.pos + 1)::numeric))
                  FILTER (WHERE e.mid = ANY(q.gold_memory_ids) AND e.pos <= 10), 0) AS dcg10,
         COALESCE(array_length(q.gold_memory_ids, 1), 0) AS n_gold
  FROM expanded e
  LEFT JOIN eval_queries q ON q.id = e.query_id
  GROUP BY e.run_id, e.query_id, q.gold_memory_ids
)
SELECT p.run_id,
       p.query_id,
       CASE WHEN LEAST(p.n_gold, 5) > 0 THEN p.dcg5 / (
         SELECT SUM(1.0 / log(2.0, (i + 1)::numeric))
         FROM generate_series(1, LEAST(p.n_gold, 5)) i) ELSE 0 END AS ndcg5,
       CASE WHEN LEAST(p.n_gold, 10) > 0 THEN p.dcg10 / (
         SELECT SUM(1.0 / log(2.0, (i + 1)::numeric))
         FROM generate_series(1, LEAST(p.n_gold, 10)) i) ELSE 0 END AS ndcg10
FROM per_query p;

-- Per-query detail (eval_run_results carries @10 only).
UPDATE eval_run_results r
SET ndcg_at_10 = b.ndcg10
FROM _ndcg_backfill b
WHERE r.run_id = b.run_id AND r.query_id = b.query_id AND r.ndcg_at_10 IS NULL;

-- Run-level rollup: plain mean over the run's queries, same as the Python.
UPDATE eval_runs e
SET ndcg_at_5  = agg.n5,
    ndcg_at_10 = agg.n10
FROM (SELECT run_id, AVG(ndcg5) AS n5, AVG(ndcg10) AS n10
      FROM _ndcg_backfill GROUP BY run_id) agg
WHERE e.id = agg.run_id AND e.ndcg_at_10 IS NULL;

COMMIT;
