-- Bucket 3: Drop the 9 always-true RLS policies on task_queue, goals, and 3 other tables.
-- Closes 9 rls_policy_always_true lints flagged in security-score-fix-2026-04-28.
-- Always-true policies (qual='true') effectively bypass RLS — they're a vestige from when
-- the dashboard used anon for write paths. Dashboard now uses service_role for all writes
-- to task_queue/goals (verified 2026-04-30), so anon writes are no longer needed.
--
-- Apply via Supabase dashboard SQL editor:
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new
--
-- service_role bypasses RLS regardless of policies, so memory-mcp / poll_queue / dashboard
-- backend routes (all server-side, all using service_role) keep working.
--
-- Affected tables: task_queue (×2), goals (×3), agent_activity, agent_heartbeat,
-- sentinel_notifications (×2). Idempotent — drops only policies with qual='true'.

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'task_queue',
        'goals',
        'agent_activity',
        'agent_heartbeat',
        'sentinel_notifications'
      )
      AND qual = 'true'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    RAISE NOTICE 'dropped policy % on %.%', pol.policyname, pol.schemaname, pol.tablename;
  END LOOP;
END $$;

-- Verification: should return zero rows after applying.
--   SELECT schemaname, tablename, policyname, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('task_queue','goals','agent_activity','agent_heartbeat','sentinel_notifications')
--     AND qual = 'true';
--
-- IMPORTANT — if anything breaks after applying:
-- 1. Identify the failing caller (it'll be hitting RLS denial on insert/update)
-- 2. Revert the specific policy with:
--    CREATE POLICY <policyname> ON <table> FOR <action> USING (true) WITH CHECK (true);
-- 3. Migrate that caller to service_role (preferred over re-adding the policy)
