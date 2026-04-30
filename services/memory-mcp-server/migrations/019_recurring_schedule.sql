-- Migration 019: Add recurring_schedule column to task_queue
-- Stores repeat schedule as a simple preset or cron expression.
-- Values: NULL / '' = one-time (default), 'daily', 'weekly', or cron string (e.g. '0 9 * * 1')

ALTER TABLE task_queue
  ADD COLUMN IF NOT EXISTS recurring_schedule TEXT DEFAULT NULL;

COMMENT ON COLUMN task_queue.recurring_schedule IS
  'Repeat schedule: NULL=one-time, ''daily'', ''weekly'', or a cron expression (e.g. ''0 9 * * 1''). '
  'When a recurring task completes the poller auto-creates the next occurrence.';
