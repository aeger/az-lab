-- Migration 052: Batch contradiction / stale-propagation scan
-- Ref: Governed Shared Memory for Multi-Agent LLM Systems (arXiv 2606.24535)
--      + daily_ai_memory_research_triage_20260703 (REC-2, EXISTS-NEEDS-MODIFICATION)
--
-- Complements auto_detect_conflicts() (per-write duplicate check, sim > 0.92) with a
-- daily batch scan over the whole active memory graph. Two failure modes covered:
--
--   1. 'contradiction' — same-topic pairs (sim in [floor, ceiling)) written by
--      DIFFERENT agents whose contents diverged over time: the cross-agent
--      stale-propagation failure mode. Pairs at sim >= p_high_conf_sim where both
--      sides are trust_tier='high' are marked HIGH-CONFIDENCE and the older memory
--      gets conflict_flagged = true so recall demotes it.
--      Excluded from candidacy (calibrated on first runs, 2026-07-03):
--        - dated journal memories (name contains YYYY-MM-DD) — point-in-time
--          reports can't contradict, only differ ("Tech Breakthrough - <date>" etc.)
--        - dated-series siblings whose names match after digit-stripping
--
--   2. 'stale' — an active memory still linked (either direction) to a superseded
--      or expired memory, with no content change since the supersession/expiry:
--      leakage of retired facts through the link graph.
--
-- Timestamps: memories.updated_at is rewritten nightly by decay/pagerank jobs
-- (all 619 rows < 36h old on 2026-07-03), so content age is derived as
-- GREATEST(created_at, last memory_log create/update) instead. Supersession time
-- is approximated by the superseding memory's created_at.
--
-- Thresholds calibrated 2026-07-03: cross-agent pairs with >7d age gap were
-- 2330 @ sim>=0.80, 450 @ >=0.86, 169 @ >=0.88, 39 @ >=0.90. Band [0.88, 0.92)
-- with top-25-per-run cap keeps the conflict queue triageable; the backlog drains
-- over successive daily runs (dedup via UNIQUE (memory_a_id, memory_b_id)).
--
-- Called daily by contradiction_scan.py via memory-contradiction-scan.timer.

create or replace function public.scan_memory_contradictions(
  p_sim_floor        double precision default 0.88,
  p_sim_ceiling      double precision default 0.92,
  p_high_conf_sim    double precision default 0.90,
  p_min_age_gap_days integer          default 7,
  p_max_new          integer          default 25
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'  -- extensions: pgvector <=> operator
as $$
declare
  v_contradictions integer := 0;
  v_high           integer := 0;
  v_flagged        integer := 0;
  v_stale          integer := 0;
begin
  -- ── 1. Cross-agent contradiction candidates (top-N by similarity per run) ──
  -- Single statement: find candidates, insert conflicts, flag older side of
  -- high-confidence pairs so recall demotes the likely-stale memory.
  with lg as (
    select memory_id, max(created_at) as last_change
    from memory_log
    where action in ('create', 'update')
    group by memory_id
  ),
  active as (
    select m.id, m.name, m.writer_agent, m.embedding, m.trust_tier,
           lower(regexp_replace(m.name, '[0-9]', '', 'g')) as series_key,
           greatest(m.created_at, coalesce(lg.last_change, m.created_at)) as content_ts
    from memories m
    left join lg on lg.memory_id = m.id
    where m.superseded_by is null
      and m.embedding is not null
      and coalesce(m.expires_at, 'infinity'::timestamptz) > now()
      and m.name !~ '\d{4}-\d{2}-\d{2}'  -- dated journal entries can't contradict
  ),
  candidates as (
    select
      least(a.id, b.id)    as a_id,
      greatest(a.id, b.id) as b_id,
      1 - (a.embedding <=> b.embedding) as sim,
      case when a.content_ts <= b.content_ts then a.id           else b.id           end as older_id,
      case when a.content_ts <= b.content_ts then a.name         else b.name         end as older_name,
      case when a.content_ts <= b.content_ts then a.writer_agent else b.writer_agent end as older_agent,
      case when a.content_ts <= b.content_ts then a.content_ts   else b.content_ts   end as older_ts,
      case when a.content_ts <= b.content_ts then b.name         else a.name         end as newer_name,
      case when a.content_ts <= b.content_ts then b.writer_agent else a.writer_agent end as newer_agent,
      case when a.content_ts <= b.content_ts then b.content_ts   else a.content_ts   end as newer_ts,
      (a.trust_tier = 'high' and b.trust_tier = 'high') as both_high_trust
    from active a
    join active b on a.id < b.id
    where a.writer_agent is not null
      and b.writer_agent is not null
      and a.writer_agent <> b.writer_agent
      -- skip dated-series siblings; keep identical literal names
      and not (a.name <> b.name and a.series_key = b.series_key)
      and 1 - (a.embedding <=> b.embedding) >= p_sim_floor
      and 1 - (a.embedding <=> b.embedding) <  p_sim_ceiling
      and abs(extract(epoch from a.content_ts - b.content_ts)) > p_min_age_gap_days * 86400
      and not exists (
        select 1 from memory_conflicts mc
        where mc.memory_a_id = least(a.id, b.id)
          and mc.memory_b_id = greatest(a.id, b.id)
      )
    order by 1 - (a.embedding <=> b.embedding) desc
    limit p_max_new
  ),
  ins as (
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by)
    select
      c.a_id, c.b_id, 'contradiction',
      case when c.sim >= p_high_conf_sim and c.both_high_trust
           then 'HIGH-CONFIDENCE: ' else '' end
        || format('Cross-agent divergence (sim %s): older "%s" [%s, %s] vs newer "%s" [%s, %s]',
             round(c.sim::numeric, 3),
             c.older_name, c.older_agent, to_char(c.older_ts, 'YYYY-MM-DD'),
             c.newer_name, c.newer_agent, to_char(c.newer_ts, 'YYYY-MM-DD')),
      'contradiction-scan'
    from candidates c
    on conflict (memory_a_id, memory_b_id) do nothing
    returning description
  ),
  flag as (
    update memories m
       set conflict_flagged = true
      from candidates c
     where m.id = c.older_id
       and c.sim >= p_high_conf_sim
       and c.both_high_trust
       and m.conflict_flagged = false
    returning m.id
  )
  select
    (select count(*) from ins),
    (select count(*) from ins where description like 'HIGH-CONFIDENCE%'),
    (select count(*) from flag)
    into v_contradictions, v_high, v_flagged;

  -- ── 2. Stale propagation through the link graph ────────────────────────────
  with lg as (
    select memory_id, max(created_at) as last_change
    from memory_log
    where action in ('create', 'update')
    group by memory_id
  ),
  edges as (
    select source_id as live_id, target_id as dead_id from memory_links
    union
    select target_id, source_id from memory_links
  ),
  ins as (
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by)
    select
      least(live.id, dead.id),
      greatest(live.id, dead.id),
      'stale',
      format('Stale propagation: active "%s" [%s] links to %s "%s" and has no content change since (%s < %s)',
        live.name, live.writer_agent,
        case when dead.superseded_by is not null then 'superseded' else 'expired' end,
        dead.name,
        to_char(greatest(live.created_at, coalesce(lg.last_change, live.created_at)), 'YYYY-MM-DD'),
        to_char(coalesce(succ.created_at, dead.expires_at), 'YYYY-MM-DD')),
      'contradiction-scan'
    from edges e
    join memories live on live.id = e.live_id
    join memories dead on dead.id = e.dead_id
    left join memories succ on succ.id = dead.superseded_by
    left join lg on lg.memory_id = live.id
    where live.superseded_by is null
      and coalesce(live.expires_at, 'infinity'::timestamptz) > now()
      and (dead.superseded_by is not null
           or coalesce(dead.expires_at, 'infinity'::timestamptz) <= now())
      and greatest(live.created_at, coalesce(lg.last_change, live.created_at))
          < coalesce(succ.created_at, dead.expires_at)
    on conflict (memory_a_id, memory_b_id) do nothing
    returning 1
  )
  select count(*) into v_stale from ins;

  return jsonb_build_object(
    'new_contradictions', v_contradictions,
    'new_high_confidence', v_high,
    'new_stale', v_stale,
    'newly_flagged_memories', v_flagged,
    'open_conflicts_total', (select count(*) from memory_conflicts where resolved = false)
  );
end;
$$;

-- Drop the superseded 4-arg signature from the first cut of this migration
drop function if exists public.scan_memory_contradictions(double precision, double precision, double precision, integer);

-- Service-role only (matches bucket2_revoke_execute posture)
revoke all on function public.scan_memory_contradictions(double precision, double precision, double precision, integer, integer) from public, anon, authenticated;
grant execute on function public.scan_memory_contradictions(double precision, double precision, double precision, integer, integer) to service_role;
