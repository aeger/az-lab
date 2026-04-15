-- Migration 015: Task queue dependency tracking
-- Adds blocked_by_task_ids column to task_queue for prerequisite task enforcement.
-- Adds GIN index for efficient array lookups.
-- Adds task_dependencies view for dependency relationship queries.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- ─── Step 1: Add blocked_by_task_ids column ───────────────────────────────────

ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS blocked_by_task_ids uuid[] DEFAULT '{}'::uuid[];

-- ─── Step 2: GIN index for efficient array containment queries ────────────────

CREATE INDEX IF NOT EXISTS idx_task_queue_blocked_by ON task_queue USING GIN (blocked_by_task_ids);

-- ─── Step 3: Dependency relationship view ─────────────────────────────────────

CREATE OR REPLACE VIEW task_dependencies AS
SELECT
  t1.id AS task_id,
  unnest(t1.blocked_by_task_ids) AS blocks_task_id
FROM task_queue t1
WHERE t1.blocked_by_task_ids IS NOT NULL
  AND array_length(t1.blocked_by_task_ids, 1) > 0;

-- ─── Step 4: Migration sentinel (callable via REST to check status) ───────────

CREATE OR REPLACE FUNCTION public.apply_task_dependency_migration_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result text := '';
BEGIN
  -- Add blocked_by_task_ids column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'task_queue' AND column_name = 'blocked_by_task_ids'
  ) THEN
    ALTER TABLE task_queue ADD COLUMN blocked_by_task_ids uuid[] DEFAULT '{}'::uuid[];
    v_result := v_result || 'added blocked_by_task_ids column; ';
  ELSE
    v_result := v_result || 'blocked_by_task_ids column exists; ';
  END IF;

  -- Create GIN index if missing
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'task_queue' AND indexname = 'idx_task_queue_blocked_by'
  ) THEN
    CREATE INDEX idx_task_queue_blocked_by ON task_queue USING GIN (blocked_by_task_ids);
    v_result := v_result || 'created GIN index; ';
  ELSE
    v_result := v_result || 'GIN index exists; ';
  END IF;

  -- Recreate view (idempotent)
  EXECUTE '
    CREATE OR REPLACE VIEW task_dependencies AS
    SELECT
      t1.id AS task_id,
      unnest(t1.blocked_by_task_ids) AS blocks_task_id
    FROM task_queue t1
    WHERE t1.blocked_by_task_ids IS NOT NULL
      AND array_length(t1.blocked_by_task_ids, 1) > 0
  ';
  v_result := v_result || 'task_dependencies view updated; ';

  RETURN TRIM(v_result);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_task_dependency_migration_if_missing() TO service_role;
