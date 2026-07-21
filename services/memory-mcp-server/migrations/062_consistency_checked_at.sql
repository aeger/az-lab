-- Migration 062: give the nightly scans a place to record their work —
--                consistency_checked_at — WITHOUT counting it as verification.
--
-- THE ASK (2026-07-21 research, Tier 3): verified_at is set on only 42/789 rows
--   (5.3%), so `COALESCE(verified_at, created_at)` in flag_stale_memories() is
--   really just "age since creation" for 95% of the table. The suggestion was to
--   have contradiction-scan / dreaming set verified_at on memories they confirm.
--
-- WHY THIS MIGRATION DOES *NOT* STAMP verified_at:
--   The contradiction scan compares memories to EACH OTHER (embedding similarity
--   between pairs). It never checks a memory against a live source. "No peer
--   memory contradicts this" is a much weaker claim than "an agent or human
--   re-confirmed this is still true of production."
--
--   Auto-stamping verified_at from that scan would mark essentially the whole
--   corpus fresh overnight — including the 475 rows migration 060 just surfaced —
--   and reset the 14-day staleness clock on rows nobody actually looked at. That
--   is precisely the "everything is fresh" illusion that 027 and 057 both created
--   and that 060 was written to end. It would silently undo today's fix.
--
--   MemGuard's framing is the relevant one: a stale-but-confident memory is more
--   dangerous than a missing one, because retrieval serves it at full trust. A
--   machine consistency pass must not be allowed to manufacture that confidence.
--
-- SO: verified_at keeps its strict meaning — an agent or human vouched, via
--   update_memory_verified(). The scan gets its own weaker, honestly-named column.
--   The two signals stay separable, and a future policy can decide what (if
--   anything) a consistency pass should be worth.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS consistency_checked_at timestamptz;

COMMENT ON COLUMN memories.consistency_checked_at IS
  'Last time the nightly contradiction scan examined this row and found no contradiction against its peers. WEAKER THAN verified_at: this is peer-consistency only, never confirmation against a live source. Deliberately NOT used by flag_stale_memories() — see migration 062 rationale.';

CREATE INDEX IF NOT EXISTS idx_memories_consistency_checked_at
  ON memories (consistency_checked_at NULLS FIRST);

-- Stamp rows that survived a scan pass clean: active, not conflict_flagged, and
-- not named in any unresolved memory_conflicts row.
CREATE OR REPLACE FUNCTION public.mark_consistency_checked()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  checked_count integer;
BEGIN
  UPDATE memories m
  SET consistency_checked_at = now()
  WHERE COALESCE(m.is_active, true) IS NOT FALSE
    AND COALESCE(m.conflict_flagged, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM memory_conflicts c
      WHERE COALESCE(c.resolved, false) = false
        AND (c.memory_a_id = m.id OR c.memory_b_id = m.id)
    );

  GET DIAGNOSTICS checked_count = ROW_COUNT;
  RETURN checked_count;
END;
$$;

COMMENT ON FUNCTION public.mark_consistency_checked() IS
  'Stamps consistency_checked_at on active, non-conflicted memories after a contradiction-scan pass. Called by contradiction_scan.py. Does NOT touch verified_at — peer consistency is not verification (migration 062).';

REVOKE EXECUTE ON FUNCTION public.mark_consistency_checked() FROM anon, authenticated;
