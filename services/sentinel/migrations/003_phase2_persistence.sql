-- Phase 2 migration: urgency column + archived status
-- Applied 2026-04-15 via Supabase MCP (apply_migration)

-- Add 'archived' to notification_status enum
ALTER TYPE notification_status ADD VALUE IF NOT EXISTS 'archived';

-- Add urgency column (critical/high/medium/low)
ALTER TABLE sentinel_notifications
  ADD COLUMN IF NOT EXISTS urgency text NOT NULL DEFAULT 'medium'
  CHECK (urgency IN ('critical', 'high', 'medium', 'low'));

-- Backfill urgency from severity
UPDATE sentinel_notifications SET urgency = CASE severity::text
  WHEN 'critical' THEN 'critical'
  WHEN 'warning'  THEN 'high'
  ELSE 'medium'
END;

-- Indexes
CREATE INDEX IF NOT EXISTS sentinel_notifications_urgency_idx
  ON sentinel_notifications (urgency);

CREATE INDEX IF NOT EXISTS sentinel_notifications_read_at_idx
  ON sentinel_notifications (read_at) WHERE read_at IS NOT NULL;
