-- Migration 006: Add 'episodic' and 'semantic' to memories.type
-- Enables episodic-to-semantic consolidation (CraniMem/ElephantBroker/Synapse pattern)
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Update the type check constraint ─────────────────────────────────
-- Find and drop the existing memories_type_check constraint, then recreate it
-- with 'episodic' and 'semantic' included alongside the original 4 types.

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  -- Find the check constraint on memories.type (any name)
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'memories'::regclass
    AND pg_get_constraintdef(oid) LIKE '%user%'
    AND pg_get_constraintdef(oid) LIKE '%feedback%'
    AND contype = 'c'
  LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE memories DROP CONSTRAINT IF EXISTS %I', v_constraint_name);
    RAISE NOTICE 'Dropped constraint: %', v_constraint_name;
  ELSE
    RAISE NOTICE 'No type check constraint found — adding new one';
  END IF;
END $$;

-- Recreate with all 6 valid types
ALTER TABLE memories
  ADD CONSTRAINT memories_type_check
  CHECK (type IN ('user', 'feedback', 'project', 'reference', 'episodic', 'semantic'));

-- ─── Step 2: Bootstrap RPC for graceful startup detection ─────────────────────

CREATE OR REPLACE FUNCTION public.apply_episodic_semantic_types_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_constraint_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_constraint_def
  FROM pg_constraint
  WHERE conrelid = 'memories'::regclass
    AND conname = 'memories_type_check';

  IF v_constraint_def IS NULL THEN
    ALTER TABLE memories
      ADD CONSTRAINT memories_type_check
      CHECK (type IN ('user', 'feedback', 'project', 'reference', 'episodic', 'semantic'));
    RETURN 'constraint created with episodic+semantic';
  ELSIF v_constraint_def NOT LIKE '%episodic%' THEN
    ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
    ALTER TABLE memories
      ADD CONSTRAINT memories_type_check
      CHECK (type IN ('user', 'feedback', 'project', 'reference', 'episodic', 'semantic'));
    RETURN 'constraint updated to include episodic+semantic';
  ELSE
    RETURN 'constraint already includes episodic+semantic';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_episodic_semantic_types_if_missing() TO service_role;

-- ─── Step 3: Index for efficient episodic consolidation queries ───────────────

CREATE INDEX IF NOT EXISTS memories_episodic_access_idx
  ON memories (access_count DESC, created_at DESC)
  WHERE type = 'episodic';

-- ─── Step 4: Verify ───────────────────────────────────────────────────────────

SELECT conname, pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'memories'::regclass
  AND conname = 'memories_type_check';
