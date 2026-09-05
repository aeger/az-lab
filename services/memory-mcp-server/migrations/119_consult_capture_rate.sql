-- Migration 119: measure consult capture as a RATE, not a count
-- ──────────────────────────────────────────────────────────────
-- MEASURED DEFECT. Migration 116/116a shipped attach_episode_consults() and it
-- works — episode 504a7b16 captured 11 consults on 2026-08-14. But 116's verify
-- block set the success criterion as "expect materially above 0": an absolute
-- count with no denominator. That is the same error v16.2 and v16.3 already cost
-- this project twice, and it hid the real picture for a day:
--
--   2026-08-15 measurement: 2 of 295 episodes carry any consult edge at all.
--   2026-08-11: 194 memories touched / 29 episodes open /  5 consults captured
--   2026-08-13: 121 memories touched /  2 episodes open /  0 consults captured
--   -> 5 captured across 315 memory-touches on the two heaviest read days.
--
-- "11 consults captured" reads as success. "0.0258 capture rate on the heaviest
-- read day" reads as what it is. The number that shipped as evidence of the fix
-- was the numerator of a ratio nobody computed.
--
-- This migration makes the ratio a first-class, always-denominated object so the
-- next research run reads it instead of re-deriving it by hand:
--   1. view public.v_consult_capture_daily
--   2. a 'consult_capture' block on memory_state_ground_truth(), which seeds the
--      memories row name='memory-mcp-server' that every daily-research run recalls.
--
-- NOT IN SCOPE: weighting outcome_utility on this signal. Capture is far too
-- sparse to fit the A-MAC fifth term against — that is the follow-up task, and it
-- is gated on this rate becoming non-trivial first. See [[amac-fifth-term-input-path]].
--
-- ─── DENOMINATOR CAVEAT (read before trusting a historical row) ───────────────
-- memories.last_accessed_at is a LAST-WRITE-WINS SNAPSHOT, not an access log.
-- memory_log records only create/update/delete — there is no read/recall action —
-- so this column is the only read signal that exists.
--
-- Consequence: a memory touched on 08-11 and touched again on 08-15 counts ONLY
-- on 08-15. A past day's memories_touched can therefore only ever SHRINK, while
-- its consults_captured is fixed once written. Historical capture_rate drifts
-- UPWARD over time and must be read as an OPTIMISTIC BOUND — the true rate on a
-- past day was at or below what this view now reports. Only the current UTC day
-- is measured against a denominator that has not yet eroded (though it is also
-- still accumulating, so it reads low until the day closes).
--
-- Do not treat a rising trend across historical rows as evidence that capture is
-- improving. Compare same-age rows, or re-read the current day.
-- ──────────────────────────────────────────────────────────────────────────────

create or replace view public.v_consult_capture_daily as
with touched as (
  select (last_accessed_at at time zone 'UTC')::date as day,
         count(*) as memories_touched
  from public.memories
  where last_accessed_at is not null
  group by 1
),
eps as (
  select (started_at at time zone 'UTC')::date as day,
         count(*) as episodes_open,
         count(*) filter (where coalesce(cardinality(memories_consulted), 0) > 0)
           as episodes_with_consults,
         coalesce(sum(coalesce(cardinality(memories_consulted), 0)), 0)
           as consults_captured
  from public.agent_episodes
  where started_at is not null
  group by 1
),
-- Separate aggregate on purpose: unnest() fans out the episode rows, so counting
-- episodes and summing cardinality in the same query as this would multiply both.
distinct_mem as (
  select (ae.started_at at time zone 'UTC')::date as day,
         count(distinct u.mid) as memories_consulted_distinct
  from public.agent_episodes ae,
       unnest(ae.memories_consulted) as u(mid)
  where ae.started_at is not null
  group by 1
),
days as (
  select day from touched
  union
  select day from eps
)
select
  d.day,
  coalesce(t.memories_touched, 0)             as memories_touched,
  coalesce(e.episodes_open, 0)                as episodes_open,
  coalesce(e.episodes_with_consults, 0)       as episodes_with_consults,
  coalesce(e.consults_captured, 0)            as consults_captured,
  coalesce(dm.memories_consulted_distinct, 0) as memories_consulted_distinct,
  -- NULL, never 0.0, when there is no denominator: "no memories were read that
  -- day" and "memories were read and none were captured" are different facts and
  -- must not print the same. Same discipline as false_carry_forward_rate.
  round(
    coalesce(e.consults_captured, 0)::numeric
      / nullif(coalesce(t.memories_touched, 0), 0),
    4
  ) as capture_rate
from days d
left join touched     t  on t.day  = d.day
left join eps         e  on e.day  = d.day
left join distinct_mem dm on dm.day = d.day;

comment on view public.v_consult_capture_daily is
  'Per-UTC-day episode consult capture WITH ITS DENOMINATOR. capture_rate = consults_captured / memories_touched, NULL when nothing was touched. Shipped because migration 116 verified attach_episode_consults() with a bare count ("materially above 0") and 11 captured edges read as success while the actual rate on the heaviest read day was 0.0258. CAVEAT: memories.last_accessed_at is a last-write-wins snapshot, not an access log, so a past day''s denominator can only shrink and its capture_rate drifts upward — historical rows are an OPTIMISTIC BOUND, only the current day is un-eroded. consults_captured counts EDGES while memories_touched counts DISTINCT memories, so capture_rate can exceed 1.0; compare against memories_consulted_distinct to tell a wide episode from a busy day.';

revoke all on public.v_consult_capture_daily from public, anon, authenticated;
grant select on public.v_consult_capture_daily to service_role;


-- ── Surface the rate in the ground truth every research run reads ────────────
-- Adds 'consult_capture' to memory_state_ground_truth(). Everything else in the
-- function is byte-identical to migration 100.
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

comment on function public.memory_state_ground_truth() is
  'Single source of live memory-subsystem state for the nightly refresh of the memories row name=''memory-mcp-server''. Reports the APPLIED migration head from the ledger, not the migrations directory — those have diverged before (076/077/078 sat in the repo looking shipped while a syntax error kept them out of the DB). Migration 119 added consult_capture, which reports a 7-day capture RATIO with its denominator; migration 116 verified the same signal with a bare count and the count read as success at a 0.0258 rate.';

revoke all on function public.memory_state_ground_truth() from public, anon, authenticated;
grant execute on function public.memory_state_ground_truth() to service_role;
