-- 005_category_never_null.sql
-- Applied to Supabase (azlab-memory / ogqjjlbupqnvlcyrfnxi) 2026-08-25.
--
-- WHY
-- sentinel_notifications.category was nullable with no default. 51 rows had
-- landed NULL (46 source=task_queue, 5 source=services, spanning 2026-04-27 →
-- 2026-08-24, i.e. still ongoing). The dashboard typed the field as non-null
-- and called .replace() on it bare, so /notifications died with
-- "Cannot read properties of null (reading 'replace')" and Next.js swapped the
-- page for the generic client-exception screen. NotificationBell had the same
-- unguarded call and renders in the site header on every page, so this was one
-- unlucky row away from taking down the whole dashboard.
--
-- Note migrations/001 declares this column `not null default ''` — but that is
-- the LOCAL sqlite schema. History reads from Supabase, where it was nullable.
-- The two stores disagreed and the TypeScript type followed the wrong one.
--
-- WHY DEFEND AT THE TABLE AND NOT AT THE WRITER
-- The writer is off-host and not in any repo on svc-podman-01:
--   * these rows carry metadata '{}' (the column default => the key was
--     OMITTED), whereas sentinel-api's persistToSupabase always sends a
--     metadata key;
--   * their timestamps match task_queue.created_at to the microsecond, so
--     something mirrors task_queue rows into notifications;
--   * every deployed collector sets category; there is no DB trigger and no
--     edge function that writes this table.
-- Most likely an agent posting straight to PostgREST from another surface
-- (Cowork/Windows). A table-level guard fixes every such writer at once,
-- including ones added later.
--
-- WHY NOT `not null`
-- PostgREST would reject those inserts outright and the notification would be
-- lost silently. Coercing is strictly better than dropping here.
--
-- DEFAULT covers an omitted key; the trigger also covers an explicit
-- "category": null and a whitespace-only string. Both paths verified by probe
-- insert before/after, probes deleted.

alter table public.sentinel_notifications
  alter column category set default 'uncategorized';

create or replace function public.sentinel_notifications_default_category()
returns trigger
language plpgsql
as $$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category := 'uncategorized';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sentinel_notifications_default_category
  on public.sentinel_notifications;

create trigger trg_sentinel_notifications_default_category
  before insert or update of category on public.sentinel_notifications
  for each row
  execute function public.sentinel_notifications_default_category();

update public.sentinel_notifications
   set category = 'uncategorized'
 where category is null or btrim(category) = '';
