-- Migration 085: make staleness DERIVED, not a flag the queue depends on a nightly writer to set
--
-- WHY (found 2026-07-28 during the stale-memory review pass, confirmed live):
--   The unverified backlog never went down (381 -> 396 -> 392 across successive passes)
--   even when agents correctly re-verified rows. Root cause is a WRITE-PATH dependency,
--   not a broken tool:
--
--     stale_memories_review_queue gates on ONE column — staleness_candidate = true.
--     It never looks at verified_at. So queue membership is only ever changed by a
--     writer that remembers to clear the flag.
--
--   Live proof (rollback-tested against prod 2026-07-28, one row through three paths):
--     update_memory_verified(id)            -> row LEAVES the queue   (0)  ✅
--     UPDATE memories SET verified_at=now() -> row STAYS in the queue (1)  ❌
--     flag_stale_memories()                 -> row leaves             (0)
--
--   So migration 057 §3 (update_memory_verified also clearing the flag) IS applied and
--   IS working — the bug report's premise that the tool "only stamps verified_at" is
--   false against live state. What actually happens is that agents on this stack stamp
--   verification through Supabase execute_sql (the documented primary tool in CLAUDE.md),
--   which writes verified_at directly and leaves staleness_candidate = true. The row then
--   sits in the queue at the same review_rank until the next nightly sweep — which is
--   exactly the "verification never leaves the queue" symptom.
--
-- THE FIX (option 2 from the bug report): the queue derives staleness from verified_at
--   directly, so it is self-consistent under EVERY write path — RPC, direct SQL, or a
--   future writer nobody has thought of yet. staleness_candidate survives as a
--   materialized cache for recall's confidence haircut, kept in sync by the same shared
--   predicate; it is no longer load-bearing for queue membership.
--
-- ONE rule, one definition: memory_is_stale() below is the single source of truth.
--   flag_stale_memories(), the review queue, and recall's +stale label all call it, so
--   they cannot drift apart the way the queue and the verify path just did.
--
-- ALSO FIXED — expired-TTL rows could never leave the queue. The 060 predicate was
--   `WHEN expires_at IS NOT NULL THEN expires_at <= now()`, evaluated fresh on every
--   sweep. Re-verifying such a row cleared the flag, then the very next sweep set it
--   straight back to true, forever, no matter how many times an agent vouched for it.
--   That is the "does the nightly sweep undo the fix?" case the report asked about:
--   for the 14-day age rule it does not (verifying moves verified_at, so should_flag
--   goes false); for the TTL rule it did. Now a row verified AFTER its expiry is
--   considered vouched-for and falls back to the normal age rule.
--   Currently 0 rows are in this state, so this is a latent fix, not a live one.

-- 1. Single source of truth for "is this row stale right now".
--    STABLE (not IMMUTABLE) — reads now(). Safe in a view predicate and in the sweep.
CREATE OR REPLACE FUNCTION public.memory_is_stale(
  p_type        text,
  p_verified_at timestamptz,
  p_created_at  timestamptz,
  p_expires_at  timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    -- Explicit TTL beats the heuristic, but only until someone vouches for the row.
    WHEN p_expires_at IS NOT NULL AND p_expires_at <= now()
      THEN COALESCE(p_verified_at, '-infinity'::timestamptz) < p_expires_at
    WHEN p_expires_at IS NOT NULL
      THEN false
    ELSE
      p_type IN ('project', 'reference')
      AND COALESCE(p_verified_at, p_created_at) < now() - interval '14 days'
  END;
$$;

COMMENT ON FUNCTION public.memory_is_stale(text, timestamptz, timestamptz, timestamptz) IS
  'Single source of truth for memory staleness (migration 085). Verification age, 14 days, project/reference only; an explicit expires_at overrides that rule until the row is verified after its expiry. Called by flag_stale_memories(), stale_memories_review_queue and the is_stale_now computed column — do not re-implement this predicate anywhere else.';

-- 2. PostgREST computed column, so the MCP server reads the SAME derived value that the
--    queue uses instead of the possibly-up-to-24h-stale cached flag. Selectable as
--    `is_stale_now` on the memories resource.
CREATE OR REPLACE FUNCTION public.is_stale_now(m public.memories)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at);
$$;

COMMENT ON FUNCTION public.is_stale_now(public.memories) IS
  'PostgREST computed column: derived staleness for a memories row. Used by recall for the confidence haircut and +stale label so they key off the same predicate as stale_memories_review_queue.';

-- 3. The sweep now only MATERIALIZES the shared predicate into staleness_candidate.
--    Behaviour is unchanged except for the expired-TTL-but-verified case above.
CREATE OR REPLACE FUNCTION public.flag_stale_memories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  flagged_count integer;
BEGIN
  UPDATE memories m
  SET staleness_candidate = public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at)
  WHERE COALESCE(m.is_active, true) IS NOT FALSE
    AND COALESCE(m.staleness_candidate, false)
        IS DISTINCT FROM public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at);

  GET DIAGNOSTICS flagged_count = ROW_COUNT;
  RETURN flagged_count;
END;
$$;

COMMENT ON FUNCTION public.flag_stale_memories() IS
  'Materializes memory_is_stale() into the staleness_candidate cache column (migration 085 moved the rule itself into memory_is_stale). The review queue no longer depends on this job having run — it derives staleness directly — so a lapse here degrades only recall''s confidence haircut, never queue correctness. Called nightly by episodic_distill.py Phase 4 and every 24h by startStalenessJob in src/index.ts.';

-- 4. The queue derives. This is the actual bug fix: a row re-verified through ANY write
--    path drops out immediately, instead of waiting for a nightly writer to notice.
CREATE OR REPLACE VIEW public.stale_memories_review_queue AS
SELECT
  m.id,
  m.name,
  m.type,
  m.trust_tier,
  COALESCE(m.access_count, 0) AS access_count,
  m.verified_at,
  m.created_at,
  m.expires_at,
  (now() - COALESCE(m.verified_at, m.created_at))::interval AS unverified_for,
  m.verified_at IS NULL AS never_verified,
  ROW_NUMBER() OVER (
    ORDER BY
      (m.expires_at IS NOT NULL AND m.expires_at <= now()) DESC,  -- explicit TTL expiry first
      COALESCE(m.access_count, 0) DESC,                           -- then hot-and-stale
      COALESCE(m.verified_at, m.created_at) ASC                   -- then oldest-unverified
  ) AS review_rank
FROM memories m
WHERE COALESCE(m.is_active, true) IS NOT FALSE
  AND public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at);

COMMENT ON VIEW public.stale_memories_review_queue IS
  'Ordered backlog of stale memories for BATCHED review. Pull with "WHERE review_rank BETWEEN x AND y" — do not review the whole set in one task. Membership is DERIVED from verification age via memory_is_stale() (migration 085); it does NOT read staleness_candidate, so stamping verified_at by any means — update_memory_verified() or a direct UPDATE — removes the row immediately. Ordering: expired-TTL first, then highest access_count (hot-and-stale = most dangerous), then oldest-unverified.';

-- 5. Index for the derived predicate. The 060 index is partial on
--    `staleness_candidate = false`, which no longer gates anything the queue reads.
CREATE INDEX IF NOT EXISTS idx_memories_staleness_derived
  ON memories (type, verified_at, created_at, expires_at)
  WHERE COALESCE(is_active, true) IS NOT FALSE;

REVOKE EXECUTE ON FUNCTION public.flag_stale_memories() FROM anon, authenticated;

-- 6. The view inherited the blanket public-schema grants from the early RLS migrations,
--    so anon/authenticated could SELECT memory names through it — and because it is a
--    (default) security-definer view, that read bypassed RLS on memories. Nothing
--    legitimate uses those roles here: the MCP server connects with the secret
--    (service_role) key. Same convention as the REVOKE above.
REVOKE ALL ON public.stale_memories_review_queue FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.memory_is_stale(text, timestamptz, timestamptz, timestamptz) FROM anon;
