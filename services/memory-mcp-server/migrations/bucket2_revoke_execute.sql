-- Bucket 2: Revoke EXECUTE on 13 SECURITY DEFINER functions from anon + authenticated.
-- Closes 26 SECURITY DEFINER lints (13 funcs × 2 roles) flagged in security-score-fix-2026-04-28.
-- These functions are intentionally SECURITY DEFINER (they bypass RLS to do their job),
-- but anon and authenticated roles never need to call them — only service_role.
-- Audit confirmed zero anon/authenticated callers in repo.
--
-- Apply via Supabase dashboard SQL editor:
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new
--
-- Idempotent — handles overloads automatically by enumerating pg_proc.

DO $$
DECLARE
  funcsig text;
BEGIN
  FOR funcsig IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'hybrid_recall',
        'hybrid_search_memories',
        'touch_memory',
        'compute_pagerank',
        'consolidate_similar_memories',
        'discard_redundant_memories',
        'flag_stale_memories',
        'prune_decayed_memories',
        'link_memories_to_skills',
        'delete_credential',
        'get_credential',
        'list_credentials',
        'upsert_credential',
        'verify_admin_token'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', funcsig);
    RAISE NOTICE 'revoked EXECUTE on %', funcsig;
  END LOOP;
END $$;

-- Verification query (optional — run separately):
--   SELECT n.nspname, p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_exec
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN (
--     'hybrid_recall','hybrid_search_memories','touch_memory','compute_pagerank',
--     'consolidate_similar_memories','discard_redundant_memories','flag_stale_memories',
--     'prune_decayed_memories','link_memories_to_skills',
--     'delete_credential','get_credential','list_credentials','upsert_credential','verify_admin_token'
--   )
--   ORDER BY p.proname;
-- All anon_can_exec values should be FALSE after applying.
