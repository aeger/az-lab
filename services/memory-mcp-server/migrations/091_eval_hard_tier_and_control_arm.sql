-- 091_eval_hard_tier_and_control_arm.sql
-- 2026-07-30 daily research, REC 1 (fix) + REC 2.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Three problems, one migration, because they are the same problem: the eval
-- harness stopped being an instrument.
--
-- 1. FCFR IS WIRED BUT VACUOUS (REC 1).
--    eval/falsify_fcfr.py settled this on 2026-07-30. The positive control
--    (mirror a real probe, set forbidden := its own gold, which is retrieved at
--    rank 1-5) forced FCFR to 0.7500 with the negative control staying clean --
--    so score() computes it correctly and it reaches eval_runs. The zero is a
--    DATA fact, not a code fact: 8 of the 9 forgetting probes declare ONLY
--    forbidden ids whose rows are is_active = false, and hybrid_recall filters
--    is_active on every one of its six lanes (14 references in the live body).
--    Those probes cannot fail by construction. FCFR = 0.0000 on the nightly was
--    measuring the WHERE clause, not the ranker.
--
--    The 8 are NOT deleted -- they are a genuine regression test that the
--    is_active filter still holds, and they would fire if a migration broke it.
--    They are instead joined by probes whose forbidden rows are REACHABLE, and
--    the harness now reports fcfr_scorable over that subset so the two readings
--    stay separable. A single blended FCFR over a mostly-vacuous denominator is
--    how the metric hid for six runs; do not recreate it.
--
-- 2. THE GATE SATURATED (REC 2).
--    post-086-tuned / nightly-20260729 / nightly-20260730 returned MRR
--    0.879464285714286 and nDCG@10 0.874719140078086 identical to the last
--    digit, Recall@5 = 1.0000 on all three. Deterministic, which is good, and
--    informationless, which is not. A ceiling that clean on a self-authored set
--    is label leakage: the probes were written alongside the memories they
--    target, so the two BM25 lanes carry them on shared vocabulary.
--
--    The hard tier below is written the other way round -- adversarial
--    paraphrases that deliberately avoid the distinctive tokens of their gold
--    (no "SFP7", no "CRS309", no "untagged", no "pngquant", no "AdGuard"), so
--    a lexical lane has nothing to match and the dense + rerank path has to
--    actually work. Modelled on LongMemEval-V2's two hardest abilities:
--      dynamic_state -- does recall return the CURRENT version of a fact whose
--                       older version is still active and lexically richer?
--      env_gotcha    -- can it find an operational gotcha from a description of
--                       the SYMPTOM, in the words someone hitting it would use?
--
-- 3. NO CONTROL ARM (REC 2, per MemDelta arXiv 2606.29914).
--    Independent evaluation found a plain GPT-4o-mini with the conversation in
--    context scores 57.6 on LongMemEval, beating most dedicated memory systems;
--    Mem0's OSS edition scored 32.4 against a claimed 93.4. Absolute scores on a
--    self-authored set are not evidence. The columns below record a
--    query-INDEPENDENT corpus-prior ranking (importance, then recency) scored
--    over the same probes -- what an agent would see with no retrieval at all --
--    so every run reports delta-over-no-memory rather than assuming it.
--
-- 4. SCORESET VERSIONING (the reason this is safe to ship tonight).
--    cmd_gate medians nDCG@10 over the trailing 7 runs and alerts at -5%.
--    Adding 13 hard probes moves the mean discontinuously at THIS migration's
--    boundary and would fire an alert attributable to nothing but a schema
--    change -- the exact unattributable-alarm failure that migration 084's
--    split denominator and the --max-fail-pct guard both exist to prevent.
--    scoreset_version fixes it structurally instead of by exception: the gate
--    only medians over runs that scored the SAME probe set. Comparing nDCG
--    across probe-set changes was never meaningful.
--
-- Reversible: all additive. Rolling back = drop the columns and set
-- active = false on the probes tagged 'hard-tier-091'.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. eval_runs: control arm, scorable-FCFR breakdown, scoreset version
-- ---------------------------------------------------------------------------
ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS ndcg_at_10_control   double precision,
  ADD COLUMN IF NOT EXISTS recall_at_5_control  double precision,
  ADD COLUMN IF NOT EXISTS delta_over_no_memory double precision,
  ADD COLUMN IF NOT EXISTS fcfr_scorable        double precision,
  ADD COLUMN IF NOT EXISTS n_forgetting         integer,
  ADD COLUMN IF NOT EXISTS n_forgetting_scorable integer,
  ADD COLUMN IF NOT EXISTS scoreset_version     integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN eval_runs.ndcg_at_10_control IS
  'MemDelta control arm: nDCG@10 of a query-INDEPENDENT corpus-prior ranking '
  '(importance desc, then recency) over the same probes. What the agent would '
  'get with retrieval switched off.';
COMMENT ON COLUMN eval_runs.delta_over_no_memory IS
  'ndcg_at_10 - ndcg_at_10_control. The only number here that says retrieval '
  'earned its keep. A small delta with a high absolute score means the corpus '
  'prior was doing the work, not the ranker.';
COMMENT ON COLUMN eval_runs.fcfr_scorable IS
  'FCFR restricted to probes with at least one REACHABLE (is_active <> false) '
  'forbidden id. Probes whose forbidden rows are all inactive cannot fail -- '
  'hybrid_recall filters is_active on every lane -- so including them in the '
  'denominator dilutes the rate toward zero and hides real carry-forward. '
  'This is the number to gate on; false_carry_forward_rate is kept for '
  'continuity with runs before 2026-07-30.';
COMMENT ON COLUMN eval_runs.scoreset_version IS
  'Bumped whenever the active probe set changes. cmd_gate only medians over '
  'runs sharing this value, so a probe-set change cannot fire a regression '
  'alert attributable to nothing but the change itself.';

-- Everything recorded before the hard tier scored the 56-probe set.
UPDATE eval_runs SET scoreset_version = 1 WHERE scoreset_version IS NULL;

-- ---------------------------------------------------------------------------
-- 1b. Widen the category CHECK for the two new hard-tier categories
-- ---------------------------------------------------------------------------
-- Kept as an enumerated CHECK rather than dropped: the constraint is what stops
-- a typo'd category from silently creating a probe class that no aggregate ever
-- reports on. Both new values are deliberate.
--
-- Neither is 'forgetting', and that is the point. score() excludes the
-- 'forgetting' category from the POSITIVE aggregate (migration 084's split
-- denominator) but counts forbidden ids for ANY probe that declares them. A
-- dynamic_state probe therefore gets scored on both sides at once — the current
-- version must come back AND the still-active older version must not — which is
-- what LongMemEval-V2 means by dynamic state tracking.
ALTER TABLE eval_queries DROP CONSTRAINT IF EXISTS eval_queries_category_check;
ALTER TABLE eval_queries ADD CONSTRAINT eval_queries_category_check
  CHECK (category = ANY (ARRAY[
    'single_hop', 'multi_hop', 'temporal', 'mined_high_recall', 'forgetting',
    'dynamic_state',  -- gold = current version, forbidden = still-ACTIVE older version
    'env_gotcha'      -- operational gotcha, asked as the symptom, no lexical overlap
  ]::text[]));

-- ---------------------------------------------------------------------------
-- 2. Mark the vacuous legacy forgetting probes so nobody re-derives this
-- ---------------------------------------------------------------------------
UPDATE eval_queries q
SET notes = coalesce(q.notes || ' | ', '') ||
    'VACUOUS as of 2026-07-30 (falsify_fcfr.py phase A): every forbidden id is '
    'is_active=false and hybrid_recall filters is_active on all six lanes, so '
    'this probe cannot contribute a carry-forward hit. Retained deliberately -- '
    'it regression-tests that the is_active filter still holds. Excluded from '
    'fcfr_scorable.'
WHERE q.category = 'forgetting'
  AND q.active
  AND NOT EXISTS (
    SELECT 1 FROM memories m
    WHERE m.id = ANY(q.forbidden_memory_ids) AND m.is_active IS NOT FALSE
  );

-- ---------------------------------------------------------------------------
-- 3. HARD TIER -- dynamic state tracking (gold AND reachable forbidden)
-- ---------------------------------------------------------------------------
-- These are scored on BOTH sides: the gold must come back (positive metrics)
-- AND the still-active older version must NOT (FCFR). That double constraint is
-- what makes them hard -- the stale rows are longer, more numerous and more
-- lexically similar to the question than the one-line correction that
-- supersedes them, so every lane's natural pull is toward the wrong answer.

INSERT INTO eval_queries (question, topic_hint, gold_memory_ids, forbidden_memory_ids, category, notes, active)
VALUES
-- The correction says bge-reranker-base; nine still-active research rows assert
-- bge-reranker-v2-m3. Deliberately sourced from the 'AI Memory Research - *'
-- series, NOT 'Daily Self-Improvement Research - *', so REC 3's retirement pass
-- cannot silently turn this probe vacuous the way the 084 probes went vacuous.
('Which relevance-scoring model file is genuinely loaded in the local container right now, as opposed to the one our notes keep repeating?',
 'model actually loaded locally',
 ARRAY['261445c7-a20a-49b7-9c99-a59f98b45801']::uuid[],
 ARRAY['5f489f78-041c-4c4c-bdb0-8f84f69ad25d','365fec1b-aabf-411d-ba49-e8fbb03f4440',
       '36535e59-a495-4683-a6b2-e9824868f030','36cedd5a-ae70-409b-a542-35dfd65ab859',
       'd168b0e4-4657-4db7-a732-f81a36972fee','ba6c1a2a-fd92-469b-a77b-3485c0fceab8',
       '04c9957b-851b-452c-a540-f8e7ef7d06e5','68f32345-ddcc-41e6-ad22-9566af3e2eac',
       '5ef6f805-da26-44d2-ba21-6de96d8f07dd']::uuid[],
 'dynamic_state',
 'hard-tier-091. Gold is the one-line correction; forbidden are nine longer, still-active rows repeating the superseded claim. Reachable, so it can actually fail.',
 true),

-- Two dated sweep logs quote 383 and 398 as the backlog. Both still active. The
-- correction says re-derive it -- it is 62, and the point-in-time flag is why.
('How many entries genuinely still need re-checking, and which flag changed that count?',
 're-derive the backlog count',
 ARRAY['3fc58e7c-44bf-438a-a657-3816fb8ac2c1']::uuid[],
 ARRAY['8b8ea83a-4449-4019-89ab-81357031f5c5','b135b48c-5b89-4223-8089-abcd98cb6926']::uuid[],
 'dynamic_state',
 'hard-tier-091. Forbidden rows are dated point-in-time logs quoting the pre-fix figures; both still active.',
 true);

-- ---------------------------------------------------------------------------
-- 4. HARD TIER -- environment gotchas, adversarial paraphrase
-- ---------------------------------------------------------------------------
-- Written as the SYMPTOM in the words of someone hitting it at 2am, with the
-- gold's distinctive vocabulary removed. Compare probe 'How must SFP7 on the
-- CRS309 be configured for the U7 Pro' (currently rank 1) with its paraphrase
-- below: same gold, no shared distinctive token. If Recall@5 stays 1.0000
-- across both, the ranker is genuinely good; if the paraphrase misses, the
-- 1.0000 was BM25 reading the question back off the memory.

INSERT INTO eval_queries (question, topic_hint, gold_memory_ids, forbidden_memory_ids, category, notes, active)
VALUES
('The ceiling wireless unit shows a healthy optical connection but never picks up an address. What did we get wrong on that fibre port?',
 'wireless unit no address fibre port',
 ARRAY['474ab1b4-9581-4a84-87f9-35773736ef1f']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Paraphrase of an existing rank-1 probe with every distinctive token removed (no SFP7 / CRS309 / VLAN / untagged / U7). Direct leakage test.',
 true),

('Before copying homepage files up from my laptop, what must I check so I do not wipe out newer work?',
 'copying files up from laptop',
 ARRAY['61a80efd-0dcd-4eb1-bcca-d9753566a5fd']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091.', true),

('Why does the bare domain answer with our public address from inside the house, while everything under it answers internally?',
 'bare domain answers publicly indoors',
 ARRAY['4b02e94b-71c5-40ba-9539-d9592ab1cdf0']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids AdGuard / rewrite / apex / split-horizon.', true),

('What is missing on the container host when I try to shrink a screenshot, and what should I reach for instead?',
 'shrinking a screenshot on the host',
 ARRAY['c4923ed5-91f3-4c7f-91e2-5d0df219f8c8']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids pngquant / ImageMagick / compression.', true),

('Does flipping a work item to taken actually stop a second worker from starting the same one?',
 'two workers on one item',
 ARRAY['aa53ce3f-d24a-4c38-b565-04ae7a3e1fdc']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids claimed / task_queue / status.', true),

('Where do I look to learn which schema changes have really run, rather than which files happen to exist?',
 'which schema changes really ran',
 ARRAY['806c0a58-2a8e-4cef-b86e-a7b1e4455aa5']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids migration / ledger / directory.', true),

('Internal pages fail only in Edge while the same links load fine from my phone. Which add-on is swallowing them?',
 'pages fail only in edge',
 ARRAY['61bd1a77-d3e2-4871-8757-b47881924fba']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids VPN / tunnel / extension name.', true),

('Which of our two fixed public addresses is set aside for the games machines?',
 'fixed public address for games',
 ARRAY['5f251bc7-5087-4677-887e-f2a2350ba58b']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids Cox / static / WAN / DMZ.', true),

('How does Jeff hand a password or token over to an agent without pasting it into chat?',
 'handing a token to an agent',
 ARRAY['587da0cf-19d5-4e42-b35d-5261a0375b7e']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids secret / drop / file path.', true),

('Which unusual port do I need to get a shell on the home-automation box?',
 'shell on the home automation box',
 ARRAY['e30b4d94-3640-4634-8828-d161aaea26a3']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids 22222 / SSH / Home Assistant.', true),

('Why did the browser-embedded terminal stop working after we rebuilt that container?',
 'embedded terminal stopped working',
 ARRAY['6292a18c-a185-45c8-b535-f82011b6171c']::uuid[], '{}'::uuid[], 'env_gotcha',
 'hard-tier-091. Avoids userns / podman / dashboard.', true);

COMMIT;
