-- Migration 016: User preferences table
-- Stores per-user settings such as sound alert preferences
-- Created: 2026-04-15 (Sentinel Phase 3 sound overhaul)

CREATE TABLE IF NOT EXISTS user_preferences (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL DEFAULT 'jeff',  -- single-user homelab, default to jeff
  key         TEXT        NOT NULL,                  -- e.g. 'sound_settings'
  value       JSONB       NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

-- Index for fast lookups by user+key
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key ON user_preferences (user_id, key);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_user_preferences_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_preferences_updated_at ON user_preferences;
CREATE TRIGGER user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_user_preferences_timestamp();

-- Seed default sound settings for jeff
INSERT INTO user_preferences (user_id, key, value)
VALUES (
  'jeff',
  'sound_settings',
  '{
    "critical": {"enabled": true,  "sound": "klaxon",      "volume": 0.8, "tts": true},
    "high":     {"enabled": true,  "sound": "sharp-chime", "volume": 0.6, "tts": false},
    "medium":   {"enabled": true,  "sound": "soft-chime",  "volume": 0.4, "tts": false},
    "low":      {"enabled": true,  "sound": "tick",        "volume": 0.25,"tts": false}
  }'
)
ON CONFLICT (user_id, key) DO NOTHING;

COMMENT ON TABLE user_preferences IS 'Per-user application preferences (sound settings, UI preferences, etc.)';
