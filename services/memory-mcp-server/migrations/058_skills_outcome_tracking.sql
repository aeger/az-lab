-- Migration 058: Skill outcome telemetry (CODESKILL pattern — 2026-07-16 research P2)
--
-- skills had use_count but no outcome signal — nothing distinguishes skills that
-- work from skills that mislead. Adds count-based outcome tracking:
--   success_count / fail_count — incremented by record_task_completion(success=...)
--   last_outcome              — free-text note of the most recent outcome
--   last_used_at              — set on every recall_skill hit
--
-- Supersedes the never-applied migration 021 (last_used + Bayesian success_rate):
-- counts are transparent and auditable; rate derives on read as
-- success_count::float / NULLIF(success_count + fail_count, 0).
-- Code writes to 021's phantom columns (skills.success_rate, skills.last_used)
-- were silently failing — v5.13.0 rewrites those paths to these columns.

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_outcome text,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_skills_last_used_at ON skills(last_used_at DESC NULLS LAST);
