-- Migration 084: forgetting-aware eval — negative golds (FAMA-style).
--
-- WHY (2026-07-26 research, tier 2):
--   The retrieval harness only ever asks "did the RIGHT memory come back?".
--   Nothing asks "did the SUPERSEDED one STOP coming back?". Those are different
--   failures and only one of them is currently measurable.
--
--   az-lab has built four separate mechanisms whose entire job is to stop serving
--   outdated facts — migration 048/048b (is_active filter on every hybrid_recall
--   lane), 056 (temporal supersession), 073 (supersession heuristic), and the
--   trust-tier down-weight lane (061). Combined regression coverage: zero. Every
--   one of them could silently stop working and all 56 existing probes would stay
--   green, because a probe that measures "gold in top-10" cannot see a stale row
--   sitting at rank 3 next to it.
--
--   This is the failure mode with teeth. A recall miss makes an agent say "I don't
--   know". A false carry-forward makes it say something confidently wrong — it
--   answers with the v5.9.0 row, or the "task_queue trigger is still OPEN" row, or
--   the "there is no unique constraint on memories.name" row, all of which read as
--   perfectly good memories and none of which are true any more.
--
-- WHAT THIS ADDS
--   eval_queries.forbidden_memory_ids — negative golds. Rows that MUST NOT appear
--     in the top-10 for that question, because a newer row supersedes them.
--   eval_runs.false_carry_forward_rate — fraction of probes (over those that
--     actually declare forbidden ids) where at least one forbidden id came back.
--     Lower is better; 0.0 is the target and the expected steady state.
--
-- CALIBRATION NOTE — READ BEFORE TRUSTING A 0.000
--   hybrid_recall already filters `is_active IS NOT FALSE` on all six candidate
--   lanes (migration 048b), so every probe below whose forbidden rows are all
--   is_active=false is a GUARD, not a finding: it is expected to read 0 from day
--   one and its value is that it goes non-zero the moment someone drops that
--   filter from a lane during a refactor. That is worth having — 048b patched six
--   near-identical lane bodies by hand and nothing has re-checked them since.
--
--   Probe 'fama-unique-name-constraint' is the exception and the reason this is
--   not just a tripwire: its forbidden row (Daily Self-Improvement Research —
--   2026-06-20) is ACTIVE. The claim inside it went stale without the row ever
--   being superseded, because the correction was written into a DIFFERENT memory.
--   No is_active filter can catch that one; only trust-tier/recency ranking can.
--   Expect that probe to be the one that actually moves.

-- 1. Schema ──────────────────────────────────────────────────────────────────
ALTER TABLE public.eval_queries
  ADD COLUMN IF NOT EXISTS forbidden_memory_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.eval_queries.forbidden_memory_ids IS
  'Negative golds (migration 084). Memory ids that MUST NOT appear in the top-10 for this question because a newer row supersedes or corrects them. Empty array = this probe makes no forgetting assertion and is excluded from the false_carry_forward_rate denominator.';

ALTER TABLE public.eval_runs
  ADD COLUMN IF NOT EXISTS false_carry_forward_rate double precision;

COMMENT ON COLUMN public.eval_runs.false_carry_forward_rate IS
  'Fraction of probes declaring forbidden_memory_ids where >=1 forbidden id appeared in the top-10 (migration 084). Denominator is probes WITH negative golds, not all probes, so it stays comparable as the positive-gold set grows. NULL on runs recorded before 084.';

-- 2. Widen the category check for the new probe class ───────────────────────
-- eval_queries_category_check (migration 068) enumerates the four LOCOMO-derived
-- categories. 'forgetting' is a fifth kind of probe, not a fifth topic: it asserts
-- an absence rather than a presence, so it gets its own category and by_category
-- reporting keeps it visually separate from the positive-recall probes.
ALTER TABLE public.eval_queries DROP CONSTRAINT IF EXISTS eval_queries_category_check;
ALTER TABLE public.eval_queries ADD CONSTRAINT eval_queries_category_check
  CHECK (category = ANY (ARRAY['single_hop','multi_hop','temporal','mined_high_recall','forgetting']));

-- 3. Seed negative golds onto the existing probe set ─────────────────────────
-- Attached to NEW probes rather than patched onto existing ones: the 56 current
-- probes are the positive-recall baseline that eval_run_trend medians over, and
-- silently changing what they assert would break comparability with the eight
-- historical runs. These are additive and carry their own category.

INSERT INTO public.eval_queries (question, topic_hint, gold_memory_ids, forbidden_memory_ids, category, notes, active)
SELECT v.question, v.topic_hint, v.gold::uuid[], v.forbidden::uuid[], 'forgetting', v.notes, true
FROM (VALUES
  (
    'What version is memory-mcp-server running and how many MCP tools does it expose?',
    'memory mcp server version',
    ARRAY['7bc3cf6b-49be-430d-846a-41786e08884f','5f23ebca-be34-48be-905f-978e4529c980'],
    ARRAY['a39a230b-1962-4097-b187-97d9bf21f392','c7e7344b-3f6a-4653-9b55-53b2fbe84b48',
          'accb7964-2e32-4404-9999-96910f3ee2c5','b67c0c2a-21d0-404a-b679-52880435756f',
          'f4b7368a-7fae-45b9-852f-1b8544de466c','236767ae-b6ee-43f7-9c24-b3d7a0b7cf3f',
          '4d4ca7dc-0b1d-408e-8902-f5900c823af8','46fdf570-30a0-46c4-90a1-7d4e3f4d0d93'],
    'Superseded version rows claim v3.2.0 / v5.9.0 / v5.10.0. Current is v5.13.0.'
  ),
  (
    'How many RRF lanes does hybrid_recall fuse and what are their weights?',
    'hybrid recall rrf lanes',
    ARRAY['00bcd966-44de-42b4-bbea-8d0239086ea5'],
    ARRAY['3dd48c65-24ae-4757-9c77-15c09c218576','c7e7344b-3f6a-4653-9b55-53b2fbe84b48',
          '46fdf570-30a0-46c4-90a1-7d4e3f4d0d93','4d4ca7dc-0b1d-408e-8902-f5900c823af8',
          '43dd3485-d575-4828-b0d4-8459ee3ff465','ff6caa79-8aba-4540-97e3-1420faf0d4db',
          'f23fffeb-7762-4a36-b876-b938a9c7cea4'],
    'Superseded rows claim 4-lane and 5-lane RRF. Verified 6 lanes (2026-07-25, pg_proc read).'
  ),
  (
    'Does task_queue stamp archived_at when a task reaches a terminal status?',
    'task queue archived_at trigger',
    ARRAY['76cd6a59-0515-47a7-a818-0d22e76f2903'],
    ARRAY['e1bfbd23-925f-45a4-8ed9-8f2d0523f57f'],
    'Forbidden row says the trigger is still OPEN; migration 075 shipped it 2026-07-25.'
  ),
  (
    'Is there a unique constraint on memories.name, or do writers need DELETE plus INSERT?',
    'memories name unique constraint',
    ARRAY['6006fc5f-a5a3-47b2-90be-c8f80b2a132f','0b760b92-0033-47a6-8ef1-3be643a27aed'],
    ARRAY['868c4e70-f884-469f-b888-4e02e1581d3c'],
    'HARDEST PROBE — forbidden row is ACTIVE, so the is_active lane filter cannot save it. Asserts "there is no unique constraint"; memories_active_name_uidx has existed since 2026-07-12.'
  ),
  (
    'How is the daily AI memory research trigger scheduled and where is it managed?',
    'ai memory research trigger schedule',
    ARRAY['2cf32882-643a-4382-89e2-03f5c614b1a3'],
    ARRAY['8b7ebabb-6326-455c-95a3-2f7ccfd90234'],
    'Superseded pre-2026-06-15-patch description of the CCR trigger.'
  ),
  (
    'Where are Supabase secrets stored after the April 2026 credential rotation?',
    'supabase key rotation storage',
    ARRAY['33bd2860-b659-4949-a7c0-11697365a98f'],
    ARRAY['21a918a7-49b1-43cf-a862-29fd15f89f2a'],
    'Superseded rotation note lacking the project-id and .env-path detail.'
  ),
  (
    'What did the 2026-05-23 AI memory research triage conclude about hybrid retrieval?',
    'may 23 memory research triage',
    ARRAY['21e1a540-1bd9-4932-a0b6-796a73098df4'],
    ARRAY['25ead254-83b2-48fc-b319-9c6f6d0c9c05','a9a3c8c2-04a5-47af-8dd5-1f1e4c0d0de3'],
    'Two superseded duplicates of the same triage.'
  ),
  (
    'What did the 2026-05-22 AI memory research triage find about the recall path?',
    'may 22 memory research triage',
    ARRAY['d79a8401-22b0-4a93-b68a-99c951afff2c'],
    ARRAY['68373477-0f2e-4b6b-8494-598795f1b315'],
    'Superseded duplicate of the 2026-05-22 triage.'
  ),
  (
    'What were the AI memory research findings on 2026-04-19 about Mem0?',
    'april 19 mem0 research findings',
    ARRAY['31181bdc-98fd-4f91-94b3-2b93aa85d69e'],
    ARRAY['69446720-baf7-4a6c-83f1-de96aadb521c'],
    'Superseded duplicate of the 2026-04-19 research memo.'
  )
) AS v(question, topic_hint, gold, forbidden, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.eval_queries e WHERE e.question = v.question
);

-- 4. Integrity check — refuse to leave dangling probe references ─────────────
-- A seeded id that does not exist (or that got merged away between authoring and
-- applying) would make the probe permanently, invisibly green: you cannot return
-- an id that is not in the corpus, so the violation count would read 0 forever.
-- Fail the migration instead of shipping a probe that can never fire.
DO $$
DECLARE missing_ids text;
BEGIN
  SELECT string_agg(DISTINCT x.id::text, ', ') INTO missing_ids
  FROM public.eval_queries e
  CROSS JOIN LATERAL unnest(e.gold_memory_ids || e.forbidden_memory_ids) AS x(id)
  WHERE e.category = 'forgetting'
    AND NOT EXISTS (SELECT 1 FROM public.memories m WHERE m.id = x.id);

  IF missing_ids IS NOT NULL THEN
    RAISE EXCEPTION 'migration 084: forgetting probes reference non-existent memory ids: %', missing_ids;
  END IF;
END $$;
