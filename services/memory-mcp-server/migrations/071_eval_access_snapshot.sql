-- Migration 071: make the retrieval regression harness non-mutating.
--
-- WHY (caught 2026-07-23 by tier counts moving between two lifecycle runs):
--   hybrid_recall is NOT a read-only function. Every call does
--     UPDATE memories SET access_count = access_count + 1,
--                         recall_count = recall_count + 1,
--                         accessed_at = now(), last_accessed_at = now()
--   for every row it returns. That is correct for production recall - usage IS
--   signal - but it makes the eval harness a corpus mutator:
--
--   * access_count is a scoring lane in the A-MAC composite, so re-running the
--     eval progressively promotes whatever the eval retrieves. The benchmark
--     would train the thing it benchmarks.
--   * access_count = 0 is the central input to lifecycle tiering AND to the
--     "77% never accessed" statistic the whole retirement case rests on.
--     One eval run of 38 queries x k=10/20 promoted 49 rows from warm to hot.
--
--   A harness whose job is to PROVE retirement did not hurt recall cannot itself
--   be perturbing the corpus between measurements.
--
-- APPROACH: snapshot/restore rather than a new hybrid_recall parameter. Adding
--   p_track_access to hybrid_recall would create a second overload (PostgREST
--   resolves RPC overloads by argument names and would go ambiguous), and
--   in-place patching that ~250-line body carries the same two-copy hazard
--   migration 061 documented. Snapshot/restore touches nothing in the recall path.
--
-- KNOWN ONE-TIME CONTAMINATION: the baseline run tagged 'baseline-post-065' was
--   executed BEFORE this migration existed, so its access_count bumps are already
--   baked in and are not recoverable (no pre-run snapshot was taken). Treat
--   pre-071 access counts as carrying a small upward bias on eval-retrieved rows.
--   The run tagged 'baseline-nonmutating' is the first clean measurement.

CREATE TABLE IF NOT EXISTS public.eval_access_snapshot (
  id               uuid PRIMARY KEY,
  access_count     integer,
  recall_count     integer,
  accessed_at      timestamptz,
  last_accessed_at timestamptz,
  last_accessed    timestamptz,
  taken_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.eval_access_snapshot IS
  'Scratch space so the retrieval regression harness can undo the access-stat side effects of hybrid_recall (migration 071). Not a backup - truncated and rewritten on every take.';

CREATE OR REPLACE FUNCTION public.eval_access_snapshot_take()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  TRUNCATE public.eval_access_snapshot;
  INSERT INTO public.eval_access_snapshot
    (id, access_count, recall_count, accessed_at, last_accessed_at, last_accessed)
  SELECT id, access_count, recall_count, accessed_at, last_accessed_at, last_accessed
  FROM memories;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.eval_access_snapshot_restore()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  UPDATE memories m
  SET access_count     = s.access_count,
      recall_count     = s.recall_count,
      accessed_at      = s.accessed_at,
      last_accessed_at = s.last_accessed_at,
      last_accessed    = s.last_accessed
  FROM public.eval_access_snapshot s
  WHERE m.id = s.id
    AND (m.access_count     IS DISTINCT FROM s.access_count
      OR m.recall_count     IS DISTINCT FROM s.recall_count
      OR m.last_accessed_at IS DISTINCT FROM s.last_accessed_at);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.eval_access_snapshot_restore IS
  'Restores access/recall counters mutated by hybrid_recall during an eval run (migration 071). Returns the number of rows repaired - a NON-ZERO result is expected and is the measure of how much the eval perturbed the corpus.';

GRANT EXECUTE ON FUNCTION public.eval_access_snapshot_take()    TO service_role;
GRANT EXECUTE ON FUNCTION public.eval_access_snapshot_restore() TO service_role;
