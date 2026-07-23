-- Migration 068: retrieval regression harness tables.
--
-- WHY: az-lab has shipped, in ~4 months, entirely by judgement and with no ground
--   truth: 6 RRF lane weights (1.0/1.2/0.8/1.5/1.3/0.5), k=60, a 6-term A-MAC
--   composite (0.25/0.20/0.15/0.25/0.15/0.10), rerank top-20->K, and a 5-value
--   trust multiplier. Not one of those constants has a regression test behind it.
--
--   Migration 061's own header documents the hazard concretely: the trust weight is
--   applied at TWO separate scoring sites inside hybrid_recall that "MUST stay
--   identical", which is why 061 patched the deployed definition with a DO block
--   instead of rewriting it. That is exactly the class of defect a 30-query
--   regression set catches in seconds and code review does not.
--
--   It is also a hard prerequisite for the migration-065 lifecycle work: retiring
--   memories is only safe if we can PROVE recall did not degrade.
--
-- SCOPE: deliberately NOT a LoCoMo port, and deliberately NOT the existing
--   eval/memory_eval.py. That harness measures INJECTION/BINDING quality and costs
--   strategies x 2 LLM calls per item. This one is a cheap, LLM-free, deterministic
--   retrieval gate: embed query -> hybrid_recall -> is the known-correct memory in
--   the top K. Runs in seconds, safe to put in front of every migration.

CREATE TABLE IF NOT EXISTS public.eval_queries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question      text        NOT NULL,
  topic_hint    text,                          -- the active-retrieval hint an agent would generate
  gold_memory_ids uuid[]    NOT NULL,          -- known-correct target(s); array supports multi-hop
  category      text        NOT NULL CHECK (category IN ('single_hop','multi_hop','temporal')),
  notes         text,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.eval_queries IS
  'Ground-truth retrieval regression set (migration 068). Hand-curated az-lab questions with known-correct memory ids. temporal category specifically covers the supersession behaviour that migrations 056/060/061 changed.';
COMMENT ON COLUMN public.eval_queries.gold_memory_ids IS
  'Any of these counted as a hit. Multi-hop rows list every memory needed to answer fully.';

CREATE TABLE IF NOT EXISTS public.eval_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag          text        NOT NULL,
  git_sha      text,
  n_queries    integer     NOT NULL,
  recall_at_1  double precision,
  recall_at_5  double precision,
  recall_at_10 double precision,
  mrr          double precision,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.eval_run_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES public.eval_runs(id) ON DELETE CASCADE,
  query_id      uuid NOT NULL REFERENCES public.eval_queries(id) ON DELETE CASCADE,
  gold_rank     integer,          -- 1-based rank of the best gold hit; NULL = miss
  hit_at_5      boolean NOT NULL,
  returned_ids  uuid[],
  latency_ms    integer
);

CREATE INDEX IF NOT EXISTS idx_eval_run_results_run ON public.eval_run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON public.eval_runs(created_at DESC);

-- Latest-vs-previous comparison, so a regression is one query away.
CREATE OR REPLACE VIEW public.eval_run_trend AS
SELECT
  r.tag, r.created_at, r.n_queries,
  round(r.recall_at_5::numeric, 4)  AS recall_at_5,
  round(r.mrr::numeric, 4)          AS mrr,
  round((r.recall_at_5 - lag(r.recall_at_5) OVER (ORDER BY r.created_at))::numeric, 4) AS d_recall_at_5,
  round((r.mrr          - lag(r.mrr)          OVER (ORDER BY r.created_at))::numeric, 4) AS d_mrr
FROM public.eval_runs r
ORDER BY r.created_at DESC;

GRANT SELECT, INSERT, UPDATE ON public.eval_queries, public.eval_runs, public.eval_run_results TO service_role;
GRANT SELECT ON public.eval_run_trend TO service_role, authenticated;

ALTER TABLE public.eval_queries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_run_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eval_queries_service ON public.eval_queries;
CREATE POLICY eval_queries_service ON public.eval_queries
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS eval_runs_service ON public.eval_runs;
CREATE POLICY eval_runs_service ON public.eval_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS eval_run_results_service ON public.eval_run_results;
CREATE POLICY eval_run_results_service ON public.eval_run_results
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- NOTE: the 38-row seed set (22 single_hop / 8 multi_hop / 8 temporal) is data,
-- not schema, and was inserted separately on 2026-07-23 because gold_memory_ids
-- are environment-specific uuids. Re-seed with:
--   SELECT question, category FROM eval_queries ORDER BY category;
