-- 109_bitemporal_recall_read_path.sql
-- 2026-08-07 — daily research TIER 1 (wire valid time into the READ path)
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Migration 108 landed `memories.valid_from` / `valid_to` and taught
-- supersede_memory() to close the interval. It stopped there on purpose:
--
--   "Nothing in the recall path reads valid_from/valid_to yet. That is
--    intentional: introducing a temporal filter into ranking is a behaviour
--    change and belongs in its own migration with its own eval run."
--
-- This is that migration. Confirmed before writing it: `grep -rn "valid_to" src/`
-- returns ZERO hits and the live hybrid_recall body contains neither column, so
-- as of today the two columns are inert — write-only storage that nothing reads.
--
-- What recall can currently express is `is_active IS NOT FALSE`, and that single
-- predicate is doing two unrelated jobs:
--
--   is_active = false  "we retired this ROW"        — a lifecycle decision
--   valid_to  < now()  "this stopped being TRUE"    — a fact about the world
--
-- They coincide today only because the sole writer of valid_to is
-- supersede_memory(), which also flips is_active. The moment anything records a
-- validity end WITHOUT retiring the row — a lease that expires next month, an IP
-- that changes on the 3rd, a cert valid until a known date — recall serves it as
-- current, because nothing looks. That is the stale-fact failure mode this pair
-- of migrations exists to close, and it is only closed at the read path.
--
-- ============================================================================
-- SCOPE
-- ============================================================================
-- One new parameter and one predicate, applied uniformly at every existing
-- `m.is_active IS NOT FALSE` site (14 of them: 5 lanes x 2 scoring sites, the
-- trgm subquery x 2, the selection site, and the final projection).
--
-- NOT in scope: temporal edges, valid-time on agent_episodes/memory_files,
-- interval overlap queries, or any change to how anything is WRITTEN.
--
-- ============================================================================
-- SEMANTICS
-- ============================================================================
-- p_as_of NULL (the default)  -> v_as_of = now(). "What is true right now."
--     Predicate: valid_from <= now() AND (valid_to IS NULL OR valid_to > now()).
--     A future-dated fact is not yet true and is withheld; a fact whose validity
--     has ended is withheld even if its row is still active. is_active keeps its
--     current meaning and is NOT relaxed.
--
-- p_as_of in the past         -> TIME TRAVEL. "What did we believe was true at T."
--     Same interval predicate at T, and `is_active` is relaxed for superseded
--     rows ONLY (superseded_by IS NOT NULL). This is the point: without that
--     relaxation an as-of query can never return history, because every fact
--     that has since been replaced was retired by the same call that closed its
--     interval, so the is_active filter would strip exactly the rows the caller
--     asked for.
--
--     Deliberately NOT relaxed: rows retired by the TTL sweep, forget(), or
--     operator deletion. Those carry no valid_to and their retirement was a
--     lifecycle decision about the row, not an observation about the world —
--     resurrecting them under a temporal flag would be a data-leak dressed as a
--     feature. The quarantine filter is likewise untouched and unconditional:
--     a poisoned row is not more trustworthy for being old.
--
-- ============================================================================
-- WHY THIS IS SAFE TO LAND (measured, not asserted)
-- ============================================================================
-- Verified against live data immediately before writing this migration:
--     984 rows · 0 with valid_from NULL · 0 with valid_from in the future
--     119 with valid_to set · 0 of those with is_active IS NOT FALSE
-- So on TODAY's data the default path (p_as_of NULL) is provably a no-op: every
-- row the new predicate would exclude is already excluded by is_active, and no
-- row has a future valid_from. That is exactly the property that makes the eval
-- gate meaningful — retrieval_regression MUST come back unchanged, and any
-- movement at all is a bug in this migration rather than a ranking tradeoff to
-- argue about.
--
-- ============================================================================
-- HOW — patched in place, never hand-copied
-- ============================================================================
-- The body is derived from pg_get_functiondef() of the LIVE function and
-- transformed by text substitution, following 093/106/107/108. Migration 093
-- exists precisely because hand-pasted function bodies drifted from what was
-- deployed; hybrid_recall is 22.8 KB and re-pasting it here would be the single
-- most likely way to silently revert someone else's tuning.
--
-- Every substitution is asserted for an exact occurrence count first, so a body
-- that no longer looks like what this expects fails loudly instead of installing
-- a function built from a stale assumption.
--
-- The 11-arg signature must be DROPped rather than CREATE OR REPLACEd: Postgres
-- keys functions by argument list, so adding a defaulted 12th parameter would
-- create a second overload and every existing 11-arg call would then be
-- ambiguous. DROP and CREATE happen inside ONE DO block so a failure in the
-- CREATE rolls the DROP back with it and cannot leave recall without a function.
-- ============================================================================

do $mig109$
declare
  v_def   text;
  v_new   text;
  v_n     integer;

  -- Anchors. Each is asserted unique (or exact-count) before substitution.
  c_sig_old  constant text := 'p_query_entities text[] DEFAULT NULL::text[])';
  c_sig_new  constant text := 'p_query_entities text[] DEFAULT NULL::text[], p_as_of timestamptz DEFAULT NULL::timestamptz)';

  c_dec_old  constant text := 'v_embedding  vector(768);';
  c_dec_new  constant text :=
      'v_as_of      timestamptz := COALESCE(p_as_of, now());' || E'\n' ||
      '  -- Time travel is opt-in AND backward-looking only. An as_of in the future is' || E'\n' ||
      '  -- a projection, not a recollection, so it gets the strict present-day filter.' || E'\n' ||
      '  v_time_travel boolean := (p_as_of IS NOT NULL AND p_as_of < now());' || E'\n' ||
      '  v_embedding  vector(768);';

  -- The uniform predicate swap. Kept on ONE line and fully parenthesised: the 14
  -- call sites splice it into AND-chains in three different shapes (line-leading
  -- `WHERE x`, mid-line `... AND x`, and mid-line `... AND x AND y`), so it must
  -- parse identically no matter what follows it.
  c_pred_old constant text := 'm.is_active IS NOT FALSE';
  c_pred_new constant text :=
      '(m.is_active IS NOT FALSE OR (v_time_travel AND m.superseded_by IS NOT NULL))'
      || ' AND (m.valid_from IS NULL OR m.valid_from <= v_as_of)'
      || ' AND (m.valid_to IS NULL OR m.valid_to > v_as_of)';
  c_pred_sites constant integer := 14;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'hybrid_recall';

  if v_def is null then
    raise exception '109: hybrid_recall() not found — nothing to patch';
  end if;

  -- Idempotence: already carries the temporal predicate, nothing to do.
  if position('v_as_of' in v_def) > 0 then
    raise notice '109: hybrid_recall() already reads valid time — no change';
    return;
  end if;

  -- ── Assert every anchor BEFORE touching anything ─────────────────────────
  v_n := (length(v_def) - length(replace(v_def, c_sig_old, ''))) / length(c_sig_old);
  if v_n <> 1 then
    raise exception '109: expected exactly 1 signature anchor, found % — refusing to patch blind', v_n;
  end if;

  v_n := (length(v_def) - length(replace(v_def, c_dec_old, ''))) / length(c_dec_old);
  if v_n <> 1 then
    raise exception '109: expected exactly 1 DECLARE anchor, found % — refusing to patch blind', v_n;
  end if;

  v_n := (length(v_def) - length(replace(v_def, c_pred_old, ''))) / length(c_pred_old);
  if v_n <> c_pred_sites then
    raise exception '109: expected % is_active sites, found % — the lane structure changed, patch by hand', c_pred_sites, v_n;
  end if;

  -- ── Transform ────────────────────────────────────────────────────────────
  v_new := replace(v_def,  c_sig_old,  c_sig_new);
  v_new := replace(v_new,  c_dec_old,  c_dec_new);
  v_new := replace(v_new,  c_pred_old, c_pred_new);

  if v_new = v_def then
    raise exception '109: replacement produced no change — aborting';
  end if;

  -- ── Swap ─────────────────────────────────────────────────────────────────
  -- Same statement as the CREATE, so a syntax error in the generated body takes
  -- the DROP down with it.
  drop function if exists public.hybrid_recall(
    text, text, double precision, integer, text, text, text,
    double precision, text, text, text[]);

  execute v_new;

  -- Replicate the ACL the dropped function carried:
  --   {=X/postgres, postgres=X/postgres, anon=X/postgres,
  --    authenticated=X/postgres, service_role=X/postgres}
  -- PUBLIC (=X) and the owner come back by default on CREATE; the three Supabase
  -- roles do not, and PostgREST calls this as authenticated/service_role.
  execute 'grant execute on function public.hybrid_recall('
       || 'text, text, double precision, integer, text, text, text, '
       || 'double precision, text, text, text[], timestamptz) '
       || 'to anon, authenticated, service_role';

  raise notice '109: hybrid_recall() now filters on valid time at % sites (p_as_of, default now())', c_pred_sites;
end
$mig109$;

comment on function public.hybrid_recall(
  text, text, double precision, integer, text, text, text,
  double precision, text, text, text[], timestamptz) is
  'Hybrid RRF recall. p_as_of (migration 109) is the BI-TEMPORAL read: NULL/omitted '
  'means "true now" and filters valid_from <= now() < valid_to, which is a no-op on '
  'rows whose valid_to only ever moves with is_active. A PAST p_as_of is a time-travel '
  'query and additionally re-admits superseded rows (superseded_by IS NOT NULL) so the '
  'history is reachable at all — TTL/forget/operator retirements stay excluded, and '
  'quarantined rows stay excluded unconditionally.';

-- ── Verification ────────────────────────────────────────────────────────────
-- Behavioural, not structural: the claim of this migration is about which rows
-- come back, so the proof has to call the function.
do $verify$
declare
  v_sites   record;
  v_now     integer;
  v_future  integer;
  v_a       uuid;
  v_b       uuid;
  v_seen    boolean;
begin
  -- 1. Migration 086's invariant survived. The predicate swap is uniform across
  --    both scoring sites, so <LANES>/<AMAC> must still be identical — if this
  --    trips, the substitution hit one site and not the other.
  for v_sites in select * from public.recall_scoring_sites_consistent() loop
    if not v_sites.identical then
      raise exception '109 verify: <%> scoring sites diverged after the patch (% sites)',
        v_sites.block, v_sites.sites;
    end if;
  end loop;

  -- 2. The default path still returns rows (a broken predicate would empty it).
  select count(*) into v_now
    from public.hybrid_recall('memory server', null::text, 0.0, 20);
  if v_now = 0 then
    raise exception '109 verify: default recall returned 0 rows — the temporal predicate is over-filtering';
  end if;

  -- 3. A future-dated fact is withheld from a now() recall, and a past as_of
  --    re-admits superseded history. Two throwaway rows, then rolled back.
  begin
    insert into public.memories (name, type, content, description, source, valid_from)
    values ('zz-109-probe-future', 'reference',
            'zzprobefuturetoken one join two', '109 probe', 'manual',
            now() + interval '30 days')
    returning id into v_a;

    select count(*) into v_future
      from public.hybrid_recall('zzprobefuturetoken', null::text, 0.0, 20);
    if v_future <> 0 then
      raise exception '109 verify: FAILED — a fact with valid_from in the future was served by a now() recall';
    end if;

    select count(*) into v_future
      from public.hybrid_recall('zzprobefuturetoken', null::text, 0.0, 20,
                                null::text, null::text, null::text, 0.0,
                                null::text, null::text, null::text[],
                                now() + interval '60 days');
    if v_future = 0 then
      raise exception '109 verify: FAILED — as_of past its valid_from still did not surface the fact';
    end if;

    -- Superseded row: invisible now, visible as-of inside its validity interval.
    -- valid_from is backdated deliberately. Both probe rows are created
    -- milliseconds apart, so valid_to lands at ~now() and any as_of far enough
    -- BELOW it to be unambiguous would also fall below a default valid_from of
    -- now() — the row would then be filtered for not having existed yet, and the
    -- test would fail for a reason that has nothing to do with time travel.
    insert into public.memories (name, type, content, description, source, valid_from)
    values ('zz-109-probe-old', 'reference', 'zzprobelineagetoken alpha', '109 probe', 'manual',
            now() - interval '7 days')
    returning id into v_a;
    insert into public.memories (name, type, content, description, source)
    values ('zz-109-probe-new', 'reference', 'zzprobelineagetoken beta', '109 probe', 'manual')
    returning id into v_b;

    perform public.supersede_memory(v_a, v_b, '109 verification probe');

    select bool_or(id = v_a) into v_seen
      from public.hybrid_recall('zzprobelineagetoken', null::text, 0.0, 20);
    if COALESCE(v_seen, false) then
      raise exception '109 verify: FAILED — a superseded row was served by a now() recall';
    end if;

    select bool_or(id = v_a) into v_seen
      from public.hybrid_recall('zzprobelineagetoken', null::text, 0.0, 20,
                                null::text, null::text, null::text, 0.0,
                                null::text, null::text, null::text[],
                                now() - interval '1 hour');   -- inside [valid_from, valid_to)
    if not COALESCE(v_seen, false) then
      raise exception '109 verify: FAILED — time travel to before the supersede did not re-admit the superseded row';
    end if;

    raise notice '109 verify: default=now() withholds future + superseded facts; past as_of re-admits history';
    raise exception 'ROLLBACK_PROBE_109';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE_109' then
        raise notice '109 verify: probes rolled back';
      else
        raise;
      end if;
  end;
end
$verify$;
