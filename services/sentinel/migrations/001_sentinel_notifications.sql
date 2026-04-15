-- Sentinel notification history table
-- Run this in the Supabase SQL editor (azlab-memory project)

create table if not exists sentinel_notifications (
  id            uuid        primary key,
  source        text        not null,
  severity      text        not null check (severity in ('info', 'warning', 'critical')),
  status        text        not null default 'unread' check (status in ('unread', 'read', 'dismissed')),
  title         text        not null,
  body          text        not null default '',
  category      text        not null default '',
  source_id     text        not null,
  source_url    text,
  metadata      jsonb,
  timestamp     timestamptz not null,
  received_at   timestamptz not null default now(),
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

-- Dedup: same source+source_id is the same event — ignore on conflict
create unique index if not exists sentinel_notifications_dedup_idx
  on sentinel_notifications (source, source_id);

-- Query performance
create index if not exists sentinel_notifications_received_at_idx
  on sentinel_notifications (received_at desc);

create index if not exists sentinel_notifications_source_idx
  on sentinel_notifications (source);

create index if not exists sentinel_notifications_status_idx
  on sentinel_notifications (status);

-- Auto-expire rows older than 30 days (keeps history table lean)
-- Run this separately if you want automatic cleanup:
-- create extension if not exists pg_cron;
-- select cron.schedule('sentinel-cleanup', '0 3 * * *',
--   $$delete from sentinel_notifications where received_at < now() - interval '30 days'$$);
