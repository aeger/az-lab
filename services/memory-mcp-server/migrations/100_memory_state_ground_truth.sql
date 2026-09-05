-- 100_memory_state_ground_truth.sql — 2026-08-02 daily research, REC 3 (TIER 3).
--
-- WHY: the memories row name='memory-mcp-server' is the single most-recalled state
-- record (access_count 174) and it seeds every daily-research run. On 2026-08-02 it
-- claimed migration head 093 and 79 eval probes; disk said 096 and the DB said 100.
-- Every agent that recalled it started from a day-stale picture, and the research
-- task burned four verification steps each morning rediscovering the same numbers.
--
-- This RPC is the ground truth those numbers should come from. memory-eval-nightly
-- already holds a DB connection and runs after every other governance timer, so it
-- is the right place to call it. Consumer: refresh_state_memory.py.
--
-- Reports BOTH the applied migration head (supabase_migrations.schema_migrations)
-- and lets the caller supply the on-disk head, because those two have diverged
-- before: migrations 076/077/078 sat in the repo for a day looking shipped while
-- a syntax error meant the database never had them. A single "head" number hides
-- exactly that failure. See [[migration-ledger-is-truth-not-the-migrations-dir]].

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

comment on function public.memory_state_ground_truth() is
  'Single source of live memory-subsystem state for the nightly refresh of the memories row name=''memory-mcp-server''. Reports the APPLIED migration head from the ledger, not the migrations directory — those have diverged before (076/077/078 sat in the repo looking shipped while a syntax error kept them out of the DB).';

revoke all on function public.memory_state_ground_truth() from public, anon, authenticated;
grant execute on function public.memory_state_ground_truth() to service_role;
