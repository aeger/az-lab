-- Migration 066: guard rails on cold-tier eligibility.
--
-- WHY: the migration-065 dry run (2026-07-23, first ever run) proposed retiring:
--   * 'U7 Pro XGS on CRS309 SFP7 - VLAN10 Untagged Gotcha'  <- verbatim in CLAUDE.md Key Gotchas
--   * 'Obsidian vault is the preferred home for all docs'   <- an ACTIVE user preference
--   * 'Cowork Startup Protocol - SSH key location'          <- live access reference
--   All three have access_count = 0 and all three are load-bearing.
--
-- ROOT CAUSE: access_count counts hybrid_recall hits ONLY. A large part of the
--   corpus reaches agents through the BOOTSTRAP layer instead - CLAUDE.md and the
--   MEMORY.md index are pasted into context at session start and never touch
--   recall(). For those rows access_count = 0 means "surfaced a different way",
--   not "unused". Using it as a utility proxy is a category error, and eviction is
--   the one operation where that error is expensive.
--
-- THE FIX (three independent guards, all must pass for cold):
--   1. type IN ('user','feedback') is NEVER cold. Preferences and identity facts
--      are durable by nature; they do not decay just because nobody queried them.
--   2. memory_class = 'procedural' is NEVER cold. Skills are reference material
--      with naturally sparse access.
--   3. lifecycle_pinned = true is NEVER cold. Explicit human/agent exemption for
--      bootstrap-surfaced rows that guard 1 and 2 do not cover.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS lifecycle_pinned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN memories.lifecycle_pinned IS
  'Exempts a memory from cold-tier assignment and eviction (migration 066). Set true for rows consumed via the CLAUDE.md/MEMORY.md bootstrap layer, where access_count=0 does not mean unused.';

CREATE OR REPLACE FUNCTION public.assign_memory_tiers()
RETURNS TABLE(tier text, n bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH scored AS (
    SELECT m.id,
      public.amac_standing_value(
        m.last_accessed_at, m.updated_at, m.created_at,
        m.access_count, m.amac_novelty_score, m.importance_score) AS sv,
      COALESCE(m.access_count, 0) AS ac,
      m.created_at, m.type, m.memory_class, m.lifecycle_pinned
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
  ), assigned AS (
    SELECT id,
      CASE
        WHEN sv >= 0.60 OR ac >= 10 THEN 'hot'
        WHEN sv < 0.45 AND ac = 0
             AND created_at < now() - interval '60 days'
             AND type NOT IN ('user', 'feedback')          -- guard 1
             AND COALESCE(memory_class, '') <> 'procedural' -- guard 2
             AND NOT lifecycle_pinned                       -- guard 3
          THEN 'cold'
        ELSE 'warm'
      END AS new_tier
    FROM scored
  )
  UPDATE memories m
  SET memory_tier = a.new_tier, tier_assigned_at = now()
  FROM assigned a
  WHERE m.id = a.id
    AND (m.memory_tier IS DISTINCT FROM a.new_tier OR m.tier_assigned_at IS NULL);

  RETURN QUERY
    SELECT m.memory_tier, count(*)
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
    GROUP BY m.memory_tier ORDER BY 1;
END;
$$;

-- Pin the rows the dry run proved are bootstrap-surfaced. These are named
-- explicitly rather than pattern-matched: an eviction exemption list should be
-- auditable, not clever.
UPDATE memories SET lifecycle_pinned = true
WHERE name IN (
  'U7 Pro XGS on CRS309 SFP7 — VLAN10 Untagged Gotcha',
  'Cowork Startup Protocol — SSH key location',
  'Cowork Startup Protocol — Check Supabase First',
  'Obsidian vault is the preferred home for all docs and notes',
  'Proxmox SSH Access',
  'MikroTik SSH Access',
  'HA VM SSH Access',
  'Claude Desktop SSH Access to svc-podman-01',
  'Cowork SSH Access to svc-podman-01',
  'Dashboard Build Process',
  'Forge Startup Protocol',
  'Task Failure Handling Protocol',
  'az-lab agentic memory harness'
);

-- Second pinning pass: operational records the first corrected dry run still
-- surfaced (live Discord channel ids, active schedule definitions).
UPDATE memories SET lifecycle_pinned = true
WHERE name IN (
  'Heather Discord Channel',
  'Daily Research Agent - Task Definition',
  'CCR Triggers — Breakthrough Watch + Daily Research',
  'Discord Channel for Claude Code',
  'Sentinel collector credentials',
  'Sentinel systemd override',
  'Goals Table Schema and Seed Data',
  'Mono repo structure',
  'Systemd service management',
  'Agent Names'
) AND COALESCE(is_active, true) IS NOT FALSE;

GRANT EXECUTE ON FUNCTION public.assign_memory_tiers() TO service_role;
