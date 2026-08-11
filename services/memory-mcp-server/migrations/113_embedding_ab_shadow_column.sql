-- 113_embedding_ab_shadow_column.sql
--
-- REC 1 of the 2026-08-03 Daily Self-Improvement Research: A/B the embedding
-- model. nomic-embed-text (768d, MTEB ~62.28) has been the embedding model since
-- day one and has never been revisited — it is the one retrieval knob that was
-- never tuned, while the RRF weights, the reranker, the trust multiplier and the
-- IDF lane have all had A/B passes.
--
-- WHAT THIS ADDS
--   memories.embedding_v2  — a SHADOW column. Nothing in the live recall path
--                            reads it. It exists so a candidate model can be
--                            scored on the real corpus through the real recall
--                            function without touching production retrieval.
--   hybrid_recall_v2()     — a byte-faithful clone of hybrid_recall() with the
--                            vector lane repointed at embedding_v2.
--
-- WHY 768 AND NOT 1024
--   qwen3-embedding:0.6b emits 1024 dims. Storing it natively would mean a
--   second index definition, a different vector(N) local in the function, and a
--   column that cannot be swapped into place without a schema change on the day
--   we adopt. qwen3 is a Matryoshka (MRL) model, so the first 768 dims are a
--   valid embedding on their own after L2-renormalisation. Truncating keeps the
--   shadow column drop-in-compatible with the live one: adoption becomes
--   `ALTER TABLE ... RENAME`, not a migration with an index rebuild.
--   The backfill script does the truncate + renormalise; this file only fixes
--   the width the two paths agree on.
--
-- WHY hybrid_recall_v2 IS DERIVED, NOT HAND-COPIED
--   hybrid_recall is ~25KB of SQL with SIX RRF lanes, and migration 061 already
--   documents that the trust weight is applied at two separate scoring sites
--   that "MUST stay identical". Hand-transcribing that for an A/B would make the
--   experiment measure my transcription instead of the embedding model. The DO
--   block below reads the LIVE definition and rewrites two identifiers, so the
--   only difference between arms is provably the column the vector lane reads.
--
-- pgvector GOTCHA: the extension lives in the `extensions` schema, not public.
-- The column type is therefore written extensions.vector explicitly. The derived
-- function inherits the original's `SET search_path`, so the unqualified
-- `vector(768)` casts inside its body keep resolving exactly as they do today.
--
-- REVERSIBILITY: additive only. Drop the column and the _v2 function to undo.
-- No live read path references either object.

BEGIN;

-- 1. Shadow column ----------------------------------------------------------
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS embedding_v2 extensions.vector(768);

COMMENT ON COLUMN public.memories.embedding_v2 IS
  'A/B shadow embedding (migration 113). Candidate model, MRL-truncated to 768 '
  'and L2-renormalised. NOT read by the live recall path — only hybrid_recall_v2. '
  'Drop this column and hybrid_recall_v2 if the candidate is not adopted.';

-- HNSW mirroring memories_embedding_hnsw EXACTLY — same opclass, same (default)
-- m / ef_construction. Deliberately no WITH clause: the live index has none, and
-- a shadow index built with different graph parameters would make the A/B a
-- comparison of index tuning wearing an embedding model's clothes.
CREATE INDEX IF NOT EXISTS memories_embedding_v2_hnsw
  ON public.memories USING hnsw (embedding_v2 vector_cosine_ops);

COMMIT;

-- 2. Shadow recall function, derived from the live one -----------------------
DO $mig113$
DECLARE
  src  text;
  v2   text;
  n    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.proname = 'hybrid_recall' AND ns.nspname = 'public';

  IF src IS NULL THEN
    RAISE EXCEPTION 'hybrid_recall() not found — cannot derive hybrid_recall_v2';
  END IF;

  -- Guard: the vector lane must look the way we expect before we rewrite it.
  -- If hybrid_recall is refactored later and these tokens move, fail loudly
  -- rather than silently emitting a v2 whose vector lane still reads the LIVE
  -- column — which would produce a clean-looking A/B of a model against itself.
  n := (length(src) - length(replace(src, 'm.embedding', ''))) / length('m.embedding');
  IF n <> 6 THEN
    RAISE EXCEPTION
      'expected 6 m.embedding references in hybrid_recall, found % — refusing to '
      'derive hybrid_recall_v2 against an unrecognised body', n;
  END IF;

  v2 := replace(src, 'public.hybrid_recall(', 'public.hybrid_recall_v2(');
  IF v2 = src THEN
    RAISE EXCEPTION 'function-name rewrite matched nothing — aborting';
  END IF;

  -- Only the vector lane moves. p_query_embedding / v_embedding are the CALLER's
  -- vector and must keep their names.
  v2 := replace(v2, 'm.embedding', 'm.embedding_v2');

  EXECUTE v2;
END
$mig113$;

COMMENT ON FUNCTION public.hybrid_recall_v2 IS
  'A/B shadow of hybrid_recall reading memories.embedding_v2 (migration 113). '
  'Derived from the live definition at migration time — re-run 113 after any '
  'change to hybrid_recall or the arms will diverge for reasons unrelated to '
  'the embedding model.';
