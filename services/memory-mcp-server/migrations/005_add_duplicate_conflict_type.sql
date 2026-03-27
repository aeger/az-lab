-- Migration 005: Add 'duplicate' to memory_conflicts conflict_type check constraint
-- The auto_detect_conflicts() function inserts conflict_type='duplicate' but the original
-- check constraint only allows: 'contradiction', 'overlap', 'stale'
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Check current constraint (informational) ─────────────────────────

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'memory_conflicts_conflict_type_check';

-- ─── Step 2: Drop the old constraint ──────────────────────────────────────────

ALTER TABLE memory_conflicts
  DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;

-- ─── Step 3: Add new constraint that includes 'duplicate' ────────────────────

ALTER TABLE memory_conflicts
  ADD CONSTRAINT memory_conflicts_conflict_type_check
  CHECK (conflict_type IN ('contradiction', 'overlap', 'stale', 'duplicate'));

-- ─── Step 4: Verify new constraint ───────────────────────────────────────────

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'memory_conflicts_conflict_type_check';

-- ─── Step 5: Test insert (verify the fix works) ───────────────────────────────

INSERT INTO memory_conflicts (memory_a_id, memory_b_id, conflict_type, severity, description, detected_at)
VALUES (
  '2f909eee-e150-4118-9f58-c5a7f2c68eec',
  '4c694547-41dc-4b21-8578-90f6e95df45f',
  'duplicate',
  'low',
  'Near-duplicate pair detected by nightly consolidation (similarity: 0.934)',
  NOW()
)
ON CONFLICT DO NOTHING;

-- ─── Step 6: Bootstrap RPC so future server restarts auto-apply this migration ──

CREATE OR REPLACE FUNCTION public.apply_duplicate_conflict_type_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_constraint_def text;
BEGIN
  -- Check if 'duplicate' is already in the constraint
  SELECT pg_get_constraintdef(oid) INTO v_constraint_def
  FROM pg_constraint
  WHERE conname = 'memory_conflicts_conflict_type_check';

  IF v_constraint_def IS NULL OR v_constraint_def NOT LIKE '%duplicate%' THEN
    -- Drop and recreate the constraint with 'duplicate' included
    ALTER TABLE memory_conflicts
      DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;
    ALTER TABLE memory_conflicts
      ADD CONSTRAINT memory_conflicts_conflict_type_check
      CHECK (conflict_type IN ('contradiction', 'overlap', 'stale', 'duplicate'));
    RETURN 'constraint updated to include duplicate';
  ELSE
    RETURN 'constraint already includes duplicate';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_duplicate_conflict_type_if_missing() TO service_role;
