-- 096_eval_tiers_abstention_and_headline_metrics.sql
-- 2026-08-01 daily research, REC 2 + REC 5.
--
-- ============================================================================
-- WHY — REC 2: recall@5 is not a dead metric, it is an INSENSITIVE one
-- ============================================================================
-- Six consecutive recorded runs, including the deliberate A/B control and both
-- treatment arms, reported recall@5 = 0.835443037974684 -- bit-identical to 15
-- decimal places (66/79). Every change shipped so far reorders documents already
-- inside the top 5; nothing moves a document across the k=5 boundary. recall@5
-- therefore cannot detect a regression OR an improvement on this scoreset.
--
-- VERIFIED BEFORE BUILDING (2026-08-01), and it corrects the research note:
-- recall@1 and nDCG@5 were ALREADY computed by score() and ALREADY stored on
-- eval_runs, and they DO move --
--     idf-off-control     R@1 0.569620  nDCG@5 0.694959
--     idf-on-treatment    R@1 0.582278  nDCG@5 0.702633
-- So REC 2 is not "add the metrics". They exist. It is that recall@5 is still
-- what the GATE, the Discord green line and --fail-under-recall5 are built on,
-- so the insensitive number is the one driving decisions while the sensitive
-- ones sit unused in the table. This migration adds what is genuinely missing
-- (tiers, per-probe scores) and the harness change moves the reporting.
--
-- HARD TIER. Mined from eval_run_results as instructed -- the ranks were already
-- recorded, no re-run needed. Over every run in the trailing 10 days, exactly
-- THREE active probes have a mean gold_rank in the 6-20 band:
--     6.15  forgetting/temporal_categorization  2026-05-22 memory research triage
--    10.00  env_gotcha                          Jeff's career before all this
--    10.00  forgetting/temporal_categorization  Supabase secrets after Apr rotation
-- Three probes is a thin tier and will not carry a gate on its own. That thinness
-- IS the finding: the scoreset has no measurable middle. Gold is at rank 1-5
-- (50/92 at rank 1) or it is missed entirely -- the 6-20 band is nearly empty, so
-- there is very little for a ranker change to move. A statistically useful hard
-- tier needs AUTHORED probes, not mined ones; the mining view below is left in
-- place so the tier re-populates automatically as the corpus grows.
--
-- ============================================================================
-- WHY — REC 5: over-retrieval is currently unmeasurable
-- ============================================================================
-- All 79 active probes have a gold set (no_gold = 0). 15 carry
-- forbidden_memory_ids, which tests "must not return X" but still expects a gold
-- hit. There is no probe of the form "nothing in the corpus answers this".
-- With retrieval that always returns SOMETHING, an agent reading recall output
-- cannot distinguish "here is the answer" from "here is the nearest neighbour of
-- a question I have no answer to". That is where confident-wrong answers come from.
-- BEAM and LoCoMo-Plus (ACL 2026) both weight unanswerable/adversarial items.
--
-- The 8 probes below were verified unanswerable against the live corpus on
-- 2026-08-01 -- not assumed. Zero active memories match 'serial number',
-- 'blood type', 'printer', or 'loki'; the four %UPS%+%runtime% hits are a VLAN
-- gotcha and podman/AI-research rows; the one %kWh% hit is energy-monitoring
-- SHOPPING research, not MS-01's draw; the one %ssid% hit is the U7 Pro XGS
-- VLAN gotcha, not a credential.
--
-- CALIBRATION RESULT — READ THIS BEFORE TRUSTING abstention_rate.
-- REC 5 specifies scoring on "returning nothing above a relevance floor". Measured
-- on 2026-08-01, hybrid_score cannot support such a floor:
--     top score, gold AT rank 1 (n=50):   min 0.8503  median 1.0263  max 1.0783
--     top score, gold NOT at rank 1 (n=42): min 0.8783  median 1.0070  max 1.0783
--     unanswerable probes:  "Jeff's blood type" -> "Agent Bus" @ 0.9704
--                           "office printer VLAN" -> "Dispatch bridge" @ 1.0023
--                           "IoT SSID password" -> "Claude Desktop SSH" @ 1.0651
-- The distributions are indistinguishable. Any floor low enough to admit correct
-- answers admits confabulations, and any floor high enough to reject the
-- confabulations rejects most correct answers. hybrid_score is a FUSION RANK
-- SCORE, not a calibrated relevance probability, and nothing in the RRF
-- construction makes it comparable across queries.
--
-- Shipping it anyway, with the floor as data and top_score recorded per probe, is
-- deliberate: the metric's job right now is to make over-retrieval VISIBLE and to
-- create the pressure for a calibrated confidence signal (top1-vs-top5 margin, or
-- the TEI cross-encoder score, which unlike hybrid_score is query-conditioned).
-- Recording top_score means that follow-up can be tuned offline against runs
-- already on disk instead of needing a re-run per candidate floor.
--
-- SCORESET VERSION. Adding 8 probes changes the population, and every aggregate
-- here is a MEAN over that population -- so the population is part of the metric
-- definition. retrieval_regression.SCORESET_VERSION goes 2 -> 3 in the same
-- commit; the gate medians only within a version, so the nightly will establish a
-- fresh trend rather than alarm on the probe-set change itself. This is the same
-- discontinuity migration 084 handled with a split denominator and 091 made
-- structural.
-- ============================================================================

BEGIN;

-- ── Tiering ────────────────────────────────────────────────────────────────
ALTER TABLE public.eval_queries
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'core';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eval_queries_tier_chk') THEN
    ALTER TABLE public.eval_queries
      ADD CONSTRAINT eval_queries_tier_chk CHECK (tier IN ('core','hard','abstention'));
  END IF;
END $$;

COMMENT ON COLUMN public.eval_queries.tier IS
  'core = ordinary gold-bearing probe. hard = gold currently lands at rank 6-20 '
  '(mined from eval_run_results, see eval_hard_tier_candidates). abstention = NO '
  'gold row exists; scored on returning nothing above the relevance floor.';

-- ── Widen the category / failure_mode vocabularies for the abstention tier ──
-- Both are CHECK constraints with a hardcoded ARRAY, so the INSERT below fails
-- with 23514 until they know the new values. Dropping and re-adding is safe here:
-- the new lists are strict supersets, so no existing row can be invalidated.
ALTER TABLE public.eval_queries DROP CONSTRAINT IF EXISTS eval_queries_category_check;
ALTER TABLE public.eval_queries ADD CONSTRAINT eval_queries_category_check
  CHECK (category = ANY (ARRAY['single_hop','multi_hop','temporal','mined_high_recall',
                               'forgetting','dynamic_state','env_gotcha','abstention']));

ALTER TABLE public.eval_queries DROP CONSTRAINT IF EXISTS eval_queries_failure_mode_check;
ALTER TABLE public.eval_queries ADD CONSTRAINT eval_queries_failure_mode_check
  CHECK (failure_mode IS NULL OR failure_mode = ANY (
    ARRAY['identifier_obfuscation','cross_lingual','prefix_collision','compound_fact',
          'lexical_categorization','temporal_categorization','over_retrieval']));

-- ── Per-probe top score, so the abstention floor is tunable offline ────────
ALTER TABLE public.eval_run_results
  ADD COLUMN IF NOT EXISTS top_score double precision;

COMMENT ON COLUMN public.eval_run_results.top_score IS
  'hybrid_score of the rank-1 returned row. Recorded for EVERY probe so the '
  'abstention relevance floor can be re-tuned against historical runs instead of '
  'requiring a fresh run per candidate floor. NULL when nothing was returned.';

-- ── Tier + abstention metrics on the run record ────────────────────────────
ALTER TABLE public.eval_runs
  ADD COLUMN IF NOT EXISTS n_hard integer,
  ADD COLUMN IF NOT EXISTS hard_recall_at_5 double precision,
  ADD COLUMN IF NOT EXISTS hard_ndcg_at_10 double precision,
  ADD COLUMN IF NOT EXISTS n_abstention integer,
  ADD COLUMN IF NOT EXISTS abstention_rate double precision,
  ADD COLUMN IF NOT EXISTS abstention_floor double precision;

COMMENT ON COLUMN public.eval_runs.abstention_rate IS
  'Fraction of abstention probes where NOTHING was returned at or above '
  'abstention_floor — i.e. the system correctly declined to answer. 1.0 is perfect. '
  'NULL when no abstention probe is active. See migration 096: hybrid_score is not '
  'calibrated across queries, so this number is only interpretable together with '
  'abstention_floor and the top_score column on eval_run_results.';

COMMENT ON COLUMN public.eval_runs.hard_ndcg_at_10 IS
  'nDCG@10 over tier=hard probes only. Reported alongside the headline so an '
  'improvement confined to already-easy probes cannot masquerade as a real gain.';

-- ── Re-mining view: which probes belong in the hard tier right now? ────────
CREATE OR REPLACE VIEW public.eval_hard_tier_candidates AS
WITH recent AS (
  SELECT id FROM public.eval_runs WHERE created_at > now() - interval '10 days'
), ranked AS (
  SELECT r.query_id,
         avg(r.gold_rank::numeric)                        AS avg_gold_rank,
         count(*)                                          AS n_runs,
         count(*) FILTER (WHERE r.gold_rank IS NULL)       AS n_missed
    FROM public.eval_run_results r
    JOIN recent ON recent.id = r.run_id
   GROUP BY r.query_id
)
SELECT q.id, q.category, q.failure_mode, q.tier AS current_tier,
       round(ranked.avg_gold_rank, 2) AS avg_gold_rank,
       ranked.n_runs, ranked.n_missed, q.question
  FROM ranked
  JOIN public.eval_queries q ON q.id = ranked.query_id
 WHERE q.active
   AND ranked.avg_gold_rank BETWEEN 6 AND 20;

COMMENT ON VIEW public.eval_hard_tier_candidates IS
  'Probes whose gold document currently lands at mean rank 6-20 over the trailing '
  '10 days — the band where a ranker change is actually measurable. Re-run the '
  'backfill in migration 096 against this view to refresh tier assignments.';

-- ── Backfill the hard tier from the mining view ────────────────────────────
UPDATE public.eval_queries q
   SET tier = 'hard'
  FROM public.eval_hard_tier_candidates c
 WHERE c.id = q.id AND q.tier = 'core';

-- ── REC 5: abstention probes ───────────────────────────────────────────────
-- gold_memory_ids is deliberately an EMPTY array, not NULL: score() distinguishes
-- "no gold exists" (abstention) from "gold not yet labelled" (a broken probe), and
-- an empty array says the first out loud.
INSERT INTO public.eval_queries
  (question, topic_hint, gold_memory_ids, category, tier, active, failure_mode, notes)
VALUES
  ('What is the serial number of the RB5009 router?',
   'rb5009 serial number', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: 0 active memories contain "serial number" (verified 2026-08-01). '
   'Adjacent-topic trap — the RB5009 is heavily documented, just never by serial.'),
  ('How many minutes of runtime does the UPS give the rack during an outage?',
   'ups battery runtime', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: the 4 rows matching UPS+runtime are a VLAN gotcha, a podman '
   'incident and AI-research digests (verified 2026-08-01). No UPS spec is stored.'),
  ('What is Jeff''s blood type?',
   'jeff blood type', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: 0 matches for "blood type" (verified 2026-08-01). Near-domain — '
   'the user profile records 12yr as a Navy Hospital Corpsman, so the corpus looks '
   'medically adjacent without containing the fact. Baseline: returned "Agent Bus" '
   'at hybrid_score 0.9704.'),
  ('Which VLAN is the office printer on?',
   'printer vlan assignment', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: 0 matches for "printer" (verified 2026-08-01), though all four '
   'VLANs are documented. Baseline: returned the Dispatch phone-bridge row at 1.0023 '
   '— ABOVE the median score of a correct rank-1 hit.'),
  ('What is the Loki log retention period in the monitoring stack?',
   'loki log retention', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: 0 matches for "loki" (verified 2026-08-01). The monitoring stack '
   'is Prometheus/Grafana; Loki is not deployed. Tests confabulation about a '
   'plausible-sounding component that does not exist.'),
  ('What did the 2027-01-15 AI memory research find?',
   '2027-01-15 research findings', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable by construction: the date is in the future, 0 memories named 2027 '
   '(verified 2026-08-01). Adversarial temporal probe — 116 dated AI-memory-research '
   'rows exist, so the lexical lanes have every incentive to return a near-date row. '
   'Baseline: returned "AI Memory Research - 2026-03-30" at 0.8944.'),
  ('What is the monthly power draw of the MS-01 in kilowatt-hours?',
   'ms-01 power consumption kwh', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: the single %kWh% match is energy-monitor SHOPPING research from '
   '2026-03-22, which prices Emporia Vue hardware and measures nothing (verified '
   '2026-08-01). Tests topic-adjacent retrieval that cannot answer the question.'),
  ('What is the WiFi password for the IoT SSID?',
   'iot ssid wifi password', '{}', 'abstention', 'abstention', true, 'over_retrieval',
   'Unanswerable: the single %ssid% match is the U7 Pro XGS VLAN10 gotcha, not a '
   'credential (verified 2026-08-01). HIGHEST-STAKES probe in the tier — baseline '
   'returned "Claude Desktop SSH Access" at 1.0651, the top of the whole score '
   'distribution, i.e. maximum confidence on a credential question it cannot answer.');

COMMIT;
