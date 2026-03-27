-- Migration: Create sessions table for Context Autopilot
-- Apply via Supabase dashboard SQL editor
-- Project: ogqjjlbupqnvlcyrfnxi (azlab-memory)

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  session_id text,
  working_context jsonb,
  active_task_id uuid,
  last_processed_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(agent)
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_write" ON sessions;
CREATE POLICY "service_role_write" ON sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read" ON sessions;
CREATE POLICY "anon_read" ON sessions
  FOR SELECT TO anon USING (true);

-- Verify
SELECT 'sessions table created' AS result;
