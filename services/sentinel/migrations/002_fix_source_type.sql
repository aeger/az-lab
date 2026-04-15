-- Fix: Convert source column from enum to text to allow all collector sources
-- (notification_source enum was missing agent_health)
-- Run via: PGPASSWORD=<db_password> psql postgresql://postgres:PASSWORD@db.ogqjjlbupqnvlcyrfnxi.supabase.co:5432/postgres -f migrations/002_fix_source_type.sql

ALTER TABLE sentinel_notifications ALTER COLUMN source TYPE text;
DROP TYPE IF EXISTS notification_source;
