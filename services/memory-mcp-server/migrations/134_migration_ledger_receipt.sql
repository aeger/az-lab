-- 134_migration_ledger_receipt.sql — 2026-08-24
--
-- WHAT WAS ACTUALLY BROKEN (measured, task 2c1b54f0)
--   On 2026-08-24 the ledger (supabase_migrations.schema_migrations) was missing
--   SIX applied migrations: 126, 126a, 126b, 127, 128, 130. All six were verified
--   live in pg_catalog. They were applied by direct SQL, which never writes the
--   ledger — only the Supabase MCP apply_migration tool does.
--
-- WHY THE EXISTING GUARD DID NOT CATCH IT
--   refresh_state_memory.py already compares applied-head vs disk-head and warns
--   loudly in both directions. But it compares the MAXIMUM only:
--       a, d = head_num(applied), head_num(disk_stem)
--   Ledger head was 132 and disk head was 132, so a == d and it reported agreement
--   while six migrations were missing from the middle. A head is an extremum, not
--   a set. An extremum cannot detect a hole.
--
--   This is the same shape as the bug 126a fixed: a predicate (here, "compare the
--   max") silently narrowed the property under measurement. The stated property
--   was "is the ledger in sync"; the tested property was "do the two maxima match".
--
-- WHAT THIS MIGRATION CHANGES
--   memory_state_ground_truth() now also emits `migrations_recorded`: the full
--   sorted array of recorded migration names. That lets the caller — which is the
--   only layer that can read the filesystem — diff SETS instead of comparing heads.
--   Per arXiv 2608.19303: report the property tested, not the adjective concluded.
--
--   `migration_head_applied` is retained (callers depend on it) but is now
--   accompanied by `migration_ledger_note` stating exactly what the ledger does and
--   does not observe, so no future reader mistakes it for a completeness signal.
--
-- Idempotent: CREATE OR REPLACE only. No data modified.

CREATE OR REPLACE FUNCTION public.record_migration_applied(
  p_name    text,
  p_version text DEFAULT to_char(now(), 'YYYYMMDDHH24MISS')
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_existing text;
BEGIN
  -- Direct-SQL appliers have no other way to record themselves. Without this the
  -- ledger only ever sees migrations applied through the Supabase MCP tool, which
  -- is what produced the six-migration hole on 2026-08-24.
  SELECT version INTO v_existing
  FROM supabase_migrations.schema_migrations WHERE name = p_name;

  IF v_existing IS NOT NULL THEN
    RETURN 'already_recorded:' || v_existing;
  END IF;

  INSERT INTO supabase_migrations.schema_migrations (version, name, created_by)
  VALUES (p_version, p_name, 'record_migration_applied')
  ON CONFLICT (version) DO NOTHING;

  RETURN 'recorded:' || p_version;
END;
$function$;

COMMENT ON FUNCTION public.record_migration_applied(text, text) IS
  'Record a migration applied via direct SQL into supabase_migrations.schema_migrations. '
  'Idempotent by name. Call this in the SAME session as any direct-SQL apply, or the '
  'ledger silently under-reports (see migration 134 header).';


-- ── Ground truth reports the recorded SET, not just the head ────────────────
-- Body is otherwise byte-identical to migration 119 (extracted programmatically,
-- not retyped, so it cannot drift from what is deployed).
create or replace function public.memory_state_ground_truth()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'migration_head_applied', (
      select name from supabase_migrations.schema_migrations order by version desc limit 1
    ),
    'migrations_applied_count', (select count(*) from supabase_migrations.schema_migrations),
    -- The full recorded SET, not just the head. A head is an extremum and cannot
    -- detect a hole: on 2026-08-24 ledger head and disk head were both 132 while
    -- 126/126a/126b/127/128/130 were missing from the middle. The caller reads the
    -- filesystem and diffs these two sets; SQL cannot see disk, so it reports the
    -- set it actually has and says so.
    'migrations_recorded', (
      select coalesce(jsonb_agg(name order by version), '[]'::jsonb)
      from supabase_migrations.schema_migrations
    ),
    'migration_ledger_note', 'schema_migrations records ONLY migrations applied via the Supabase MCP apply_migration tool or public.record_migration_applied(). Direct-SQL applies are invisible to it. Therefore migration_head_applied and migrations_applied_count are NOT completeness signals on their own — diff migrations_recorded against the .sql files on disk.',
    'corpus', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where is_active),
        'inactive', count(*) filter (where not is_active),
        'retired', count(*) filter (where retired_at is not null),
        'conflict_flagged', count(*) filter (where conflict_flagged),
        'staleness_candidate', count(*) filter (where staleness_candidate),
        'missing_embedding', count(*) filter (where embedding is null)
      ) from public.memories
    ),
    'trust_tiers', (
      select coalesce(jsonb_object_agg(coalesce(trust_tier,'null'), n), '{}'::jsonb)
      from (select trust_tier, count(*) n from public.memories group by 1) t
    ),
    'eval', (
      select jsonb_build_object(
        'active_probes', count(*) filter (where active),
        'by_tier', (
          select coalesce(jsonb_object_agg(tier, n), '{}'::jsonb)
          from (select coalesce(tier,'core') tier, count(*) n from public.eval_queries where active group by 1) x
        ),
        'with_forbidden', count(*) filter (where active and array_length(forbidden_memory_ids,1) > 0)
      ) from public.eval_queries
    ),
    'latest_eval_run', (
      select to_jsonb(r) - 'id' from (
        select tag, git_sha, n_queries, scoreset_version, recall_at_1, recall_at_5,
               ndcg_at_5, ndcg_at_10, mrr, fcfr_scorable,
               n_hard, hard_recall_at_5, hard_ndcg_at_10,
               n_abstention, abstention_rate, created_at
        from public.eval_runs order by created_at desc limit 1
      ) r
    ),
    -- Consult capture, always as a ratio with its denominator attached. Never
    -- report consults_captured on its own — that bare count is the defect this
    -- block exists to close. window_days is stated so a reader can re-derive.
    'consult_capture', (
      select jsonb_build_object(
        'window_days', 7,
        'memories_touched', coalesce(sum(memories_touched), 0),
        'episodes_open', coalesce(sum(episodes_open), 0),
        'episodes_with_consults', coalesce(sum(episodes_with_consults), 0),
        'consults_captured', coalesce(sum(consults_captured), 0),
        'capture_rate', round(
          coalesce(sum(consults_captured), 0)::numeric
            / nullif(coalesce(sum(memories_touched), 0), 0), 4),
        'episode_attach_rate', round(
          coalesce(sum(episodes_with_consults), 0)::numeric
            / nullif(coalesce(sum(episodes_open), 0), 0), 4),
        'episodes_with_consults_alltime', (
          select count(*) from public.agent_episodes
          where coalesce(cardinality(memories_consulted), 0) > 0
        ),
        'episodes_alltime', (select count(*) from public.agent_episodes),
        'denominator_note', 'memories_touched derives from last_accessed_at, a last-write-wins snapshot, not an access log. Past days can only lose touches, so this rate is an OPTIMISTIC BOUND. See view v_consult_capture_daily.'
      )
      from public.v_consult_capture_daily
      where day > (now() at time zone 'UTC')::date - 7
    ),
    'conflicts', (
      select jsonb_build_object(
        'total', count(*),
        'open', count(*) filter (where not resolved)
      ) from public.memory_conflicts
    ),
    'injection_scan', (
      select jsonb_build_object(
        'scanned_active', count(*) filter (where is_active and scan_pattern_version is not null),
        'never_scanned_active', count(*) filter (where is_active and scan_pattern_version is null),
        'pattern_version', max(scan_pattern_version),
        'last_scan_at', max(injection_scanned_at),
        'findings_pending', (select count(*) from public.memory_scan_findings where status='pending'),
        'findings_confirmed', (select count(*) from public.memory_scan_findings where status='confirmed'),
        'findings_accepted_risk', (select count(*) from public.memory_scan_findings where status='accepted_risk')
      ) from public.memories
    ),
    'skills', (
      select jsonb_build_object(
        'total', count(*),
        'with_outcome_data', count(*) filter (where coalesce(success_count,0) + coalesce(fail_count,0) > 0)
      ) from public.skills
    )
  );
$$;

revoke all on function public.memory_state_ground_truth() from public, anon, authenticated;
grant execute on function public.memory_state_ground_truth() to service_role;
revoke all on function public.record_migration_applied(text, text) from public, anon, authenticated;
grant execute on function public.record_migration_applied(text, text) to service_role;
