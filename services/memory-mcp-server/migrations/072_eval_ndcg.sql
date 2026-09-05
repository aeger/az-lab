-- 072_eval_ndcg.sql
-- Add nDCG@k to the retrieval regression harness (2026-07-24 self-improvement research rec 2).
--
-- WHY: retrieval_regression.py (migration 068/071) gates recall-path changes on
-- recall@k + MRR only. The research asked specifically for nDCG so a change that
-- reshuffles the *order* of correct hits (e.g. an RRF-weight or rerank tweak that
-- keeps the gold in the top-k but demotes it) is still caught. recall@k is blind to
-- rank once the hit is inside k; MRR only credits the single best hit; nDCG@k credits
-- every gold hit, discounted by position — the right signal for multi-gold probes.
--
-- Additive only: new nullable columns + view rebuild. No data change, no RLS
-- surface (eval_runs already exists with RLS from migration 068).

ALTER TABLE public.eval_runs ADD COLUMN IF NOT EXISTS ndcg_at_5  double precision;
ALTER TABLE public.eval_runs ADD COLUMN IF NOT EXISTS ndcg_at_10 double precision;
-- per-query nDCG@10 for drill-down into which probes lost rank between runs.
ALTER TABLE public.eval_run_results ADD COLUMN IF NOT EXISTS ndcg_at_10 double precision;

-- Allow the mined probe category (build_probes.py expands the seed toward the 50-100
-- the research asked for; mined probes carry a separate category so they stay auditable
-- and prunable vs the hand-curated single/multi/temporal set).
ALTER TABLE public.eval_queries DROP CONSTRAINT IF EXISTS eval_queries_category_check;
ALTER TABLE public.eval_queries ADD CONSTRAINT eval_queries_category_check
  CHECK (category = ANY (ARRAY['single_hop','multi_hop','temporal','mined_high_recall']));

-- Rebuild the trend view to surface nDCG@10 alongside recall@5 / MRR.
-- DROP+CREATE (not REPLACE): the new column is inserted mid-list, which
-- CREATE OR REPLACE VIEW forbids. Only the regression harness reads this view.
DROP VIEW IF EXISTS public.eval_run_trend;
CREATE VIEW public.eval_run_trend AS
  SELECT tag,
    created_at,
    n_queries,
    round(recall_at_5::numeric, 4)  AS recall_at_5,
    round(mrr::numeric, 4)          AS mrr,
    round(ndcg_at_10::numeric, 4)   AS ndcg_at_10,
    round((recall_at_5 - lag(recall_at_5) OVER (ORDER BY created_at))::numeric, 4)  AS d_recall_at_5,
    round((mrr        - lag(mrr)        OVER (ORDER BY created_at))::numeric, 4)     AS d_mrr,
    round((ndcg_at_10 - lag(ndcg_at_10) OVER (ORDER BY created_at))::numeric, 4)     AS d_ndcg_at_10
  FROM eval_runs r
  ORDER BY created_at DESC;
