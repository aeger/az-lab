-- Migration 020: Fix sentinel oid-ambiguity + add concurrent_write conflict type
--
-- Changes:
-- 1. Fix "column reference 'oid' is ambiguous" in apply_dual_bm25_hybrid_recall_if_missing
--    (pg_proc and pg_namespace both have oid — must qualify as p.oid)
-- 2. Add 'concurrent_write' to memory_conflicts conflict_type check constraint
--    (enables logging when two agents write the same memory within a short time window)
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Part 1: Fix oid-ambiguous sentinel function ──────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_dual_bm25_hybrid_recall_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  func_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO func_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall'
  LIMIT 1;

  IF func_body LIKE '%bm25_plain%' THEN
    RETURN 'migration 017: hybrid_recall dual-BM25 (search_vec + search_vector) RRF active';
  ELSE
    RETURN 'WARNING: hybrid_recall missing bm25_plain CTE — re-apply 017_dual_bm25_hybrid_recall.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_dual_bm25_hybrid_recall_if_missing()
  TO service_role, authenticated;

-- ─── Part 2: Add 'concurrent_write' to conflict_type constraint ───────────────

ALTER TABLE memory_conflicts
  DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;

ALTER TABLE memory_conflicts
  ADD CONSTRAINT memory_conflicts_conflict_type_check
  CHECK (conflict_type IN ('contradiction', 'overlap', 'stale', 'duplicate', 'concurrent_write'));

-- ─── Part 3: Sentinel for constraint check ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_migration_020_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_constraint_def text;
  v_func_body text;
  sentinel_parts text[] := ARRAY[]::text[];
BEGIN
  -- Check concurrent_write in constraint
  SELECT pg_get_constraintdef(c.oid) INTO v_constraint_def
  FROM pg_constraint c
  WHERE c.conname = 'memory_conflicts_conflict_type_check';

  IF v_constraint_def IS NULL OR v_constraint_def NOT LIKE '%concurrent_write%' THEN
    ALTER TABLE memory_conflicts
      DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;
    ALTER TABLE memory_conflicts
      ADD CONSTRAINT memory_conflicts_conflict_type_check
      CHECK (conflict_type IN ('contradiction', 'overlap', 'stale', 'duplicate', 'concurrent_write'));
    sentinel_parts := sentinel_parts || 'constraint updated';
  ELSE
    sentinel_parts := sentinel_parts || 'constraint ok';
  END IF;

  -- Check sentinel function fix
  SELECT pg_get_functiondef(p.oid) INTO v_func_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_dual_bm25_hybrid_recall_if_missing'
  LIMIT 1;

  IF v_func_body LIKE '%p.oid%' THEN
    sentinel_parts := sentinel_parts || 'sentinel-oid-fix ok';
  ELSE
    sentinel_parts := sentinel_parts || 'sentinel-oid-fix needed (re-apply migration 020)';
  END IF;

  RETURN 'migration 020: ' || array_to_string(sentinel_parts, ', ');
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_migration_020_if_missing()
  TO service_role, authenticated;
