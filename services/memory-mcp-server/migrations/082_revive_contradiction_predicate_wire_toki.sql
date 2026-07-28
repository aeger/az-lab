-- Migration 082: revive the contradiction predicate and wire the TOKI heuristic into it.
--
-- DEFECT 1 -- the predicate could not fire (watch item, 2026-07-27 research).
--   memory-contradiction-scan has run daily since 2026-07-13 with zero detections.
--   Measured 2026-07-28 over the live corpus: 15 pairs fall in the [0.88, 0.92)
--   similarity band, but ZERO of them are cross-agent. writer_agent is wren on
--   738 of 833 live rows, so `a.writer_agent <> b.writer_agent` excludes ~97% of
--   pairs, and the residue never lands in the narrow band. The conjunction
--   (cross-agent AND 0.88<=sim<0.92 AND 7-day gap) is empirically unsatisfiable --
--   the same structurally-dead predicate shape as migrations 057 and 060.
--   FIX: drop the cross-agent requirement. Same-agent contradictions are real
--   (wren writes 89% of memories; it contradicts itself over time). Both sides
--   must still HAVE a writer_agent. Measured effect: 3 new conflicts, not a flood.
--
-- DEFECT 2 -- migration 078 defined trust_tier_to_heuristic() and nothing called it.
--   Detectors inserted memory_conflicts rows leaving resolution_heuristic NULL,
--   which is the same "populated but unread" defect 061/076 addressed one level up.
--   FIX: stamp public.trust_tier_to_heuristic(tier_a, tier_b) at both INSERT sites
--   (contradiction and stale propagation), so every new row carries its heuristic
--   and a low/quarantined-vs-high/verified contradiction is held for confirmation
--   instead of silently auto-resolving (arXiv 2606.22030).
--
-- NOTE: migration 083 subsequently widened the dated-journal exclusion in this same
-- function to also match compact YYYYMMDD names. This file reflects 082 only.
--
-- Everything else is byte-identical to the deployed pre-082 definition.

CREATE OR REPLACE FUNCTION public.scan_memory_contradictions(
  p_sim_floor double precision DEFAULT 0.88,
  p_sim_ceiling double precision DEFAULT 0.92,
  p_high_conf_sim double precision DEFAULT 0.90,
  p_min_age_gap_days integer DEFAULT 7,
  p_max_new integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_contradictions integer := 0;
  v_high           integer := 0;
  v_flagged        integer := 0;
  v_stale          integer := 0;
begin
  -- 1. Contradiction candidates (top-N by similarity per run)
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
      (a.trust_tier = 'high' and b.trust_tier = 'high') as both_high_trust,
      a.trust_tier as tier_a,
      b.trust_tier as tier_b
    from active a
    join active b on a.id < b.id
    where a.writer_agent is not null
      and b.writer_agent is not null
      -- NOTE: the `a.writer_agent <> b.writer_agent` requirement was removed in
      -- migration 082 -- it made this predicate unsatisfiable (see header).
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
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by, resolution_heuristic)
    select
      c.a_id, c.b_id, 'contradiction',
      case when c.sim >= p_high_conf_sim and c.both_high_trust
           then 'HIGH-CONFIDENCE: ' else '' end
        || format('Divergence (sim %s): older "%s" [%s, %s] vs newer "%s" [%s, %s]',
             round(c.sim::numeric, 3),
             c.older_name, c.older_agent, to_char(c.older_ts, 'YYYY-MM-DD'),
             c.newer_name, c.newer_agent, to_char(c.newer_ts, 'YYYY-MM-DD')),
      'contradiction-scan',
      public.trust_tier_to_heuristic(c.tier_a, c.tier_b)
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

  -- 2. Stale propagation through the link graph
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
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by, resolution_heuristic)
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
      'contradiction-scan',
      public.trust_tier_to_heuristic(live.trust_tier, dead.trust_tier)
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
$function$;
