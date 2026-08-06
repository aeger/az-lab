-- 108_bitemporal_valid_time.sql
-- 2026-08-06 — daily research TIER 2 (bi-temporal validity)
--
-- ============================================================================
-- WHY
-- ============================================================================
-- `memories` carries 51 columns and every temporal one is INGESTION or
-- LIFECYCLE time: created_at, updated_at, accessed_at, verified_at, expires_at,
-- retired_at, tier_assigned_at, plus is_active / superseded_by / retired_at.
-- All of them answer "when did we touch this row." None answers "when was this
-- true in the world."
--
-- So recall can answer "what did we most recently write" but cannot answer
-- "what was true as of T", and a fact that stopped being true is only
-- distinguishable from a current one if somebody remembered to supersede it.
-- The 2026 literature (arXiv 2606.26511, and Zep/Graphiti in production)
-- converges on the same fix: store two timelines, and on contradiction stamp
-- the old assertion with an end-of-validity instead of deleting it —
-- invalidate, never delete.
--
-- az-lab already owns the expensive half. Migration 105 repaired the supersedes
-- lineage (119 correctly-directed edges, confirmed today) and supersede_memory()
-- is a single chokepoint that every retirement already flows through — the MCP
-- tool and the mem0 auto-supersede path both call the same RPC. Adding a valid
-- interval and writing valid_to at supersede time converts that existing lineage
-- into a queryable temporal index for the cost of two columns.
--
-- ============================================================================
-- SCOPE — deliberately small
-- ============================================================================
-- Two columns and one write-path change. This is NOT a temporal knowledge
-- graph: no bi-temporal recall mode, no as-of query API, no edge invalidation,
-- no rewrite of hybrid_recall. az-lab does not need Graphiti. Those can be built
-- later ON these columns; they cannot be built without them, which is the whole
-- reason to land the columns now while the supersede path is being touched.
--
-- Nothing in the recall path reads valid_from/valid_to yet. That is intentional:
-- introducing a temporal filter into ranking is a behaviour change and belongs
-- in its own migration with its own eval run.
--
-- ============================================================================
-- SEMANTICS
-- ============================================================================
--   valid_from  when the fact became true in the world.
--   valid_to    when it stopped being true. NULL = still true (open interval).
--
-- Both are best-effort proxies on existing rows: nothing recorded real-world
-- validity before today, so valid_from backfills from created_at and valid_to
-- from the superseding row's created_at. That is honest — the moment we learned
-- the replacement is the tightest upper bound available for when the old fact
-- stopped holding. Callers that actually know better ("the IP changed on the
-- 3rd, we noticed on the 9th") can set valid_from explicitly on write; that is
-- exactly the case ingestion time cannot represent and this column can.
-- ============================================================================

-- ── 1. The two columns ──────────────────────────────────────────────────────
-- valid_from defaults to now() so every future write gets an open interval
-- without touching a single call site. A row is "currently true" iff
-- valid_to is null.
alter table public.memories
  add column if not exists valid_from timestamptz default now(),
  add column if not exists valid_to   timestamptz;

comment on column public.memories.valid_from is
  'VALID TIME (bi-temporal): when this fact became true in the world — NOT when the row was written (that is created_at). Backfilled from created_at, which is a proxy, not a measurement. Set explicitly when the real date is known and differs from ingestion.';
comment on column public.memories.valid_to is
  'VALID TIME end. NULL = still true. Stamped by supersede_memory() when a newer memory replaces this one — invalidate, never delete. A non-null valid_to means "this was true, and is not any more", which is different from is_active=false ("we retired this row").';

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
update public.memories
   set valid_from = created_at
 where valid_from is null
    or valid_from <> created_at;

-- Already-superseded rows get their interval closed at the moment the
-- replacement was written. Verified before writing this: 119 superseded rows,
-- 0 with a superseding row older than themselves, 0 dangling superseded_by
-- pointers, and exactly 119 matching 'supersedes' edges — so this backfill
-- cannot produce an inverted interval.
update public.memories o
   set valid_to = n.created_at
  from public.memories n
 where o.superseded_by = n.id
   and o.valid_to is null;

-- ── 3. Interval sanity ──────────────────────────────────────────────────────
-- Cheap, and the one class of corruption that makes every later temporal query
-- silently wrong. Equality is allowed: a fact corrected within the same instant
-- has a zero-length validity, which is meaningful, not an error.
alter table public.memories
  drop constraint if exists memories_valid_interval_ck;
alter table public.memories
  add constraint memories_valid_interval_ck
  check (valid_to is null or valid_from is null or valid_to >= valid_from);

-- Partial index: the overwhelmingly common temporal predicate is "facts that
-- are still true", i.e. valid_to is null. Indexing the open intervals keeps it
-- small — currently ~857 of 976 rows, and it stays proportional to live facts
-- rather than to total history.
create index if not exists idx_memories_valid_from_open
  on public.memories (valid_from desc)
  where valid_to is null;

-- ── 4. Write path ───────────────────────────────────────────────────────────
-- supersede_memory() is patched IN PLACE rather than re-pasted. Migration 093
-- exists because hand-copied function bodies drifted from what was deployed;
-- 106 and 107 both follow this discipline. The edit is asserted, so if the live
-- body no longer looks like what this expects, the migration fails loudly
-- instead of installing a function built from a stale assumption.
--
-- COALESCE(valid_to, now()) — never clobber an existing value. If a caller
-- already recorded when the fact actually stopped being true, that is a real
-- measurement and it outranks "now, because we noticed now".
do $migration$
declare
  v_def text;
  v_new text;
  v_old_set constant text := 'SET superseded_by = p_new_id, is_active = false, updated_at = now()';
  v_new_set constant text := 'SET superseded_by = p_new_id, is_active = false, updated_at = now(), valid_to = COALESCE(valid_to, now())';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'supersede_memory' and n.nspname = 'public';

  if v_def is null then
    raise exception '108: supersede_memory() not found — nothing to patch';
  end if;

  if position(v_new_set in v_def) > 0 then
    raise notice '108: supersede_memory() already stamps valid_to — no change';
    return;
  end if;

  if position(v_old_set in v_def) = 0 then
    raise exception '108: supersede_memory() UPDATE clause not found in live body — refusing to patch blind';
  end if;

  v_new := replace(v_def, v_old_set, v_new_set);
  if v_new = v_def then
    raise exception '108: replacement produced no change — aborting';
  end if;

  execute v_new;
  raise notice '108: supersede_memory() now closes the valid interval on the superseded row';
end
$migration$;

-- ── Verification ────────────────────────────────────────────────────────────
do $verify$
declare
  v_open      bigint;
  v_closed    bigint;
  v_orphan    bigint;
  v_inverted  bigint;
  v_a         uuid;
  v_b         uuid;
  v_valid_to  timestamptz;
begin
  select count(*) filter (where valid_to is null),
         count(*) filter (where valid_to is not null),
         count(*) filter (where valid_from is null),
         count(*) filter (where valid_to is not null and valid_to < valid_from)
    into v_open, v_closed, v_orphan, v_inverted
    from public.memories;

  if v_orphan > 0 then
    raise exception '108 verify: % row(s) have no valid_from', v_orphan;
  end if;
  if v_inverted > 0 then
    raise exception '108 verify: % inverted interval(s)', v_inverted;
  end if;

  -- Every superseded row must now have a closed interval. This is the actual
  -- claim of the migration; counting rows is what proves the backfill ran.
  select count(*) into v_orphan
    from public.memories
   where superseded_by is not null and valid_to is null;
  if v_orphan > 0 then
    raise exception '108 verify: % superseded row(s) still have an open interval', v_orphan;
  end if;

  raise notice '108 verify: % open / % closed intervals, all superseded rows closed', v_open, v_closed;

  -- Live end-to-end proof of the write path. Two throwaway memories, supersede
  -- one with the other, assert the interval closed, then remove both. Rolled
  -- back via a raised exception so nothing survives even on success.
  begin
    insert into public.memories (name, type, content, description, source)
    values ('zz-108-probe-old', 'reference', 'probe row A', '108 verification probe', 'manual')
    returning id into v_a;
    insert into public.memories (name, type, content, description, source)
    values ('zz-108-probe-new', 'reference', 'probe row B', '108 verification probe', 'manual')
    returning id into v_b;

    perform public.supersede_memory(v_a, v_b, '108 verification probe');

    select valid_to into v_valid_to from public.memories where id = v_a;
    if v_valid_to is null then
      raise exception '108 verify: FAILED — supersede_memory() did not stamp valid_to';
    end if;
    if (select valid_to from public.memories where id = v_b) is not null then
      raise exception '108 verify: FAILED — the SUPERSEDING row had its interval closed';
    end if;

    raise exception 'ROLLBACK_PROBE_108';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE_108' then
        raise notice '108 verify: supersede_memory() closes the old interval and leaves the new one open';
      else
        raise;
      end if;
  end;
end
$verify$;
