-- Phase 4: Intelligence Layer
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run
-- URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new

-- Extension heartbeat (Guardian monitors this)
CREATE TABLE IF NOT EXISTS sentinel_extension_heartbeat (
  extension_id   text PRIMARY KEY DEFAULT 'default',
  last_seen      timestamptz NOT NULL DEFAULT now(),
  user_agent     text,
  version        text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Guardian self-heal event log
CREATE TABLE IF NOT EXISTS sentinel_guardian_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     text NOT NULL CHECK (event_type IN ('extension_dead', 'reconnect_requested', 'self_healed', 'discord_alerted')),
  extension_id   text NOT NULL DEFAULT 'default',
  details        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sentinel_guardian_events_created_at_idx ON sentinel_guardian_events (created_at DESC);
CREATE INDEX IF NOT EXISTS sentinel_guardian_events_type_idx ON sentinel_guardian_events (event_type);

-- Sound Director weekly suggestion log
CREATE TABLE IF NOT EXISTS sentinel_sound_suggestions (
  week_start     date PRIMARY KEY,
  suggestion     jsonb NOT NULL,
  hours_analyzed int,
  samples_used   int,
  posted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Weekly health report log
CREATE TABLE IF NOT EXISTS sentinel_health_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date    date NOT NULL UNIQUE,
  report         jsonb NOT NULL,
  posted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotent migration sentinel (callable via Supabase REST API)
CREATE OR REPLACE FUNCTION public.apply_sentinel_phase4_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  CREATE TABLE IF NOT EXISTS sentinel_extension_heartbeat (
    extension_id   text PRIMARY KEY DEFAULT 'default',
    last_seen      timestamptz NOT NULL DEFAULT now(),
    user_agent     text,
    version        text,
    updated_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sentinel_guardian_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type     text NOT NULL CHECK (event_type IN ('extension_dead', 'reconnect_requested', 'self_healed', 'discord_alerted')),
    extension_id   text NOT NULL DEFAULT 'default',
    details        jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS sentinel_guardian_events_created_at_idx ON sentinel_guardian_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS sentinel_guardian_events_type_idx ON sentinel_guardian_events (event_type);

  CREATE TABLE IF NOT EXISTS sentinel_sound_suggestions (
    week_start     date PRIMARY KEY,
    suggestion     jsonb NOT NULL,
    hours_analyzed int,
    samples_used   int,
    posted_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sentinel_health_reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date    date NOT NULL UNIQUE,
    report         jsonb NOT NULL,
    posted_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  RETURN 'phase4 tables applied';
END;
$$;
