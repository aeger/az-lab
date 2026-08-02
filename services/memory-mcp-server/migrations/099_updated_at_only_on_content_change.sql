-- 099_updated_at_only_on_content_change.sql
-- 2026-08-02. Found while verifying 098, not predicted by the research note.
--
-- ============================================================================
-- THE BUG — updated_at has ALREADY been destroyed, nightly, for some time
-- ============================================================================
-- 098 stopped the injection backfill from flattening memories.updated_at. Then
-- the verification query showed the damage was already done by other jobs:
--
--   select updated_at, count(*) from memories group by 1 order by 2 desc;
--     2026-08-02 03:30:13.377+00   456
--     2026-08-02 05:02:33.401+00   193
--     2026-08-02 03:00:00.209+00   143
--     2026-08-02 04:10:08.906+00    30
--
-- Every one of 955 rows has updated_at on 2026-08-02, in four clumps that are
-- exactly the nightly governance timers. The cause is the same as 098's: those
-- jobs write BOOKKEEPING columns in bulk — contradiction_scan.py's
-- mark_consistency_checked() stamps consistency_checked_at on 456 rows at 03:30,
-- the lifecycle pass stamps memory_tier / tier_assigned_at, the TTL sweep stamps
-- staleness_candidate — and the unconditional memories_updated_at trigger turned
-- each of those into "this memory changed".
--
-- So updated_at currently means "when a cron job last looked at this row", not
-- "when this memory last changed". Everything derived from it is reading noise:
--   * scan_memory_contradictions() — "contents diverged > 7 days apart" (052)
--     can never be true; every pair is now hours apart.
--   * detect_temporal_supersession() — newest-wins ordering (056) is arbitrary.
--   * the stale-review queue / recall staleness discount (085/089/090).
--   * weekly-memory-consolidation's 30-day window — matches everything.
-- This is very likely part of why the contradiction scan's high-confidence lane
-- has been quiet and why the stale-queue numbers have been hard to reason about.
--
-- ============================================================================
-- THE FIX
-- ============================================================================
-- Restrict the trigger with an UPDATE OF column list, so only writes to columns
-- that constitute the MEMORY ITSELF bump updated_at. Telemetry, scoring and
-- governance bookkeeping no longer count as a content change.
--
-- The 098 GUC escape hatch is kept. It is still needed for deliberate timeline
-- repair (setting updated_at explicitly), which is otherwise impossible, and it
-- costs nothing.
--
-- NOTE — this does not un-flatten what was already lost. The pre-2026-08-02
-- values are not recoverable from memory_log (it stores content, not timestamps).
-- The daily Supabase JSON exports under ~/backups/supabase/<date>/memories.json.gz
-- DO carry them, so a reconstruction is possible from the oldest retained export
-- if it is ever worth doing. Flagging rather than attempting: picking which
-- historical snapshot is "the" truth for 955 rows is a judgement call for Jeff,
-- not a migration.
--
-- Adding a new content-bearing column later? Add it to the list below, or edits
-- to it will silently not bump updated_at.

begin;

drop trigger if exists memories_updated_at on public.memories;

create trigger memories_updated_at
  before update of
    -- the memory itself
    name, description, content, tags, type, memory_class,
    -- how much it is to be believed / how long it lives
    confidence, confidence_tier, importance_score, expires_at, trust_tier,
    -- lifecycle state that a human or agent chose
    is_active, retired_at, retire_reason, superseded_by, lifecycle_pinned,
    is_point_in_time,
    -- ownership and reach
    source, writer_agent, agent_id, agent_scope, visibility, visibility_scope,
    propagation,
    -- the semantic payload
    embedding
  on public.memories
  for each row
  execute function public.memories_update_updated_at();

comment on trigger memories_updated_at on public.memories is
  'Bumps updated_at ONLY when the memory itself changes. Deliberately excludes bookkeeping/telemetry columns — accessed_at, access_count, recall_count, last_accessed*, conflict_flagged, consistency_checked_at, verified_at, staleness_candidate, memory_tier, tier_assigned_at, pagerank_score, amac_novelty_score, extracted_facts, facts_extracted_at, entities, content_hash, injection_scanned_at, scan_pattern_version. Before 2026-08-02 the trigger fired on all of these, so the nightly governance timers stamped updated_at on the whole corpus every night and every timestamp-derived signal (052 contradiction age gap, 056 supersession ordering, 085/089/090 staleness) was reading cron activity instead of content change.';

commit;
