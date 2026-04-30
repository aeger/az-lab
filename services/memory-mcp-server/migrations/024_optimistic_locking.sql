-- Migration 024: optimistic locking version column
--
-- Adds a version counter to memories so concurrent agents use compare-and-swap
-- rather than blind last-write-wins. Write path: read version, update WHERE id=X
-- AND version=N, SET version=version+1. If 0 rows updated, another agent won — retry.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Idempotent sentinel
CREATE OR REPLACE FUNCTION public.apply_optimistic_locking_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'version'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 024: version column active — optimistic locking enabled';
  ELSE
    RETURN 'WARNING: version column missing — re-apply 024_optimistic_locking.sql';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_optimistic_locking_if_missing()
  TO service_role, authenticated;
