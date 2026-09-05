-- 098_updated_at_ignores_scan_bookkeeping.sql
-- 2026-08-02, REC 1 follow-on. Found while building the retro-scan, not predicted
-- by the research note.
--
-- THE BUG THIS PREVENTS
-- memories_updated_at is `BEFORE UPDATE ... FOR EACH ROW EXECUTE update_updated_at()`
-- with no WHEN clause, and update_updated_at() is unconditionally
-- `new.updated_at = now()`. The 097 backfill writes nothing but
-- injection_scanned_at and scan_pattern_version, so it would have stamped
-- updated_at = now() on all 955 rows in a single pass.
--
-- updated_at is not decoration here. It feeds:
--   * scan_memory_contradictions() — "contents diverged > 7 days apart" (052)
--   * detect_temporal_supersession() — newest-wins ordering (056)
--   * the stale-review queue and the recall staleness discount (085/089/090)
--   * weekly-memory-consolidation's 30-day window
-- Flattening the corpus to one timestamp would have made every memory look
-- simultaneously fresh and mutually contemporaneous — silently emptying the stale
-- queue and destroying the age gaps supersession is derived from. Unrecoverable:
-- the prior values exist nowhere else.
--
-- WHY NOT A WHEN CLAUSE
-- The obvious fix — `when (to_jsonb(old) - scan_cols is distinct from to_jsonb(new) - scan_cols)`
-- is rejected by Postgres:
--     42P17: BEFORE trigger's WHEN condition cannot reference NEW generated columns
-- memories carries generated columns, so a whole-row NEW reference is illegal in a
-- BEFORE ... WHEN. Doing the same diff inside the function body does not work
-- either: in a BEFORE trigger the generated columns are not yet computed, so
-- to_jsonb(new) reads NULL for them while to_jsonb(old) has the stored value, and
-- every row would compare as "changed" — a guard that silently never fires.
--
-- THE FIX
-- An explicit opt-out GUC, set TRANSACTION-LOCALLY by the one RPC allowed to write
-- scan bookkeeping. (A `SET azlab.skip_updated_at` function attribute would be
-- tidier but Supabase's postgres role cannot declare a custom GUC class:
-- 42501 permission denied to set parameter. set_config(..., is_local => true) is
-- runtime and needs no such privilege.) is_local scopes the flag to the current
-- transaction, and PostgREST gives every RPC call its own, so it cannot leak into
-- another statement; it is also reset explicitly before returning. And
-- stamp_injection_scan() is physically incapable of writing any other column, so
-- the exemption cannot be borrowed to hide a real content change.

begin;

-- ── 1. Trigger function that honours the opt-out ────────────────────────────
-- Dedicated to memories. update_updated_at() is shared with other tables and is
-- left exactly as it is.
create or replace function public.memories_update_updated_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Flag on => this statement is scan bookkeeping (or a deliberate timeline
  -- repair). Pass NEW through untouched rather than forcing OLD's value back:
  -- an UPDATE that never mentions updated_at already carries OLD's value in NEW,
  -- so the rescan preserves it either way -- but force-assigning made updated_at
  -- literally unwritable, including for restoring a value from backup.
  if coalesce(current_setting('azlab.skip_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists memories_updated_at on public.memories;

create trigger memories_updated_at
  before update on public.memories
  for each row
  execute function public.memories_update_updated_at();

comment on trigger memories_updated_at on public.memories is
  'Bumps updated_at on every update EXCEPT inside stamp_injection_scan(), so the weekly injection rescan cannot flatten the corpus timeline that contradiction detection (052), temporal supersession (056) and the stale queue (085/089/090) are derived from.';

-- ── 2. The only writer of scan bookkeeping ──────────────────────────────────
create or replace function public.stamp_injection_scan(
  p_ids        uuid[],
  p_version    integer,
  p_scanned_at timestamptz default now()
) returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_count integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  perform set_config('azlab.skip_updated_at', 'on', true);

  update public.memories
     set injection_scanned_at = p_scanned_at,
         scan_pattern_version = p_version
   where id = any(p_ids);

  get diagnostics v_count = row_count;

  perform set_config('azlab.skip_updated_at', 'off', true);
  return v_count;
exception when others then
  perform set_config('azlab.skip_updated_at', 'off', true);
  raise;
end;
$$;

comment on function public.stamp_injection_scan(uuid[], integer, timestamptz) is
  'Records that rows were checked against threat-patterns.json version N. The ONLY path that may write injection_scanned_at / scan_pattern_version, and the only caller that suppresses the updated_at bump. Writes no other column by construction.';

revoke all on function public.stamp_injection_scan(uuid[], integer, timestamptz) from public, anon, authenticated;
grant execute on function public.stamp_injection_scan(uuid[], integer, timestamptz) to service_role;

commit;
