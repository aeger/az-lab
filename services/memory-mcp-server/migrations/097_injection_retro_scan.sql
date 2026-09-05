-- 097_injection_retro_scan.sql
-- 2026-08-02 daily research, REC 1 (TIER 1).
--
-- ============================================================================
-- WHY — scanContent() has only ever run on the way IN
-- ============================================================================
-- src/index.ts scanContent() is called from exactly three places, all of them
-- write paths: remember (1382), save_skill (2448), set_memory_block (2890).
-- Migration 076 put that gate in place on 2026-07-21.
--
-- Measured 2026-08-02 against the live corpus:
--     total memories                955
--     created_at < 2026-07-21       785   (82% — never passed through the scanner)
--     trust_tier = 'quarantined'      0
--
-- Those two numbers together are the finding. quarantined=0 is NOT evidence of a
-- clean corpus; it is exactly what "nothing older than 076 was ever checked"
-- looks like. OWASP ASI06 (Memory and Context Poisoning, Agentic AI Top 10 2026)
-- names four interception points. az-lab had shipped three:
--     1. write-time admission        -> 076
--     2. provenance binding          -> 064 (+ 050/051 writer_agent autofill)
--     3. retrieval-time filtering    -> 061 trust lane + 081 hard quarantine filter
--     4. post-hoc forensic detection -> THIS MIGRATION
-- MPBench (arXiv 2607.14611) is blunt about why 4 matters: write-time scanning
-- alone is not a defense, because the attack and its effect are temporally
-- decoupled. A row admitted under an older pattern set stays admitted forever.
--
-- ============================================================================
-- WHAT THIS DOES — and deliberately does NOT do
-- ============================================================================
-- Adds scan bookkeeping to memories, plus a REVIEW table. It does not quarantine
-- anything and grants nothing the power to. That restraint is the design, not
-- timidity: trust_tier='quarantined' drops a row to recall weight 0.40 and behind
-- the 081 hard filter, so a false positive silently deletes a memory from every
-- agent's view with no error anywhere. And the current pattern set is KNOWN to be
-- false-positive-heavy on this specific corpus — `authorized_keys` and `~/.ssh`
-- match az-lab's own SSH bootstrap documentation, which is why those two patterns
-- carry severity 'low' in threat-patterns.json. First pass writes findings for a
-- human; the reviewer decides.
--
-- The version column is the actual point. Today scanning is forward-only: a
-- pattern added tomorrow never sees anything written yesterday.
-- memories.scan_pattern_version records WHICH pattern set cleared a row, so
-- memory-injection-rescan.timer (weekly) can re-scan every row that is behind the
-- current version. Bumping `version` in src/threat-patterns.json is what makes a
-- new pattern retroactive.
--
-- Cost: pure SQL + regex over 955 rows. No new container, no model calls.
-- ============================================================================

begin;

-- ── 1. Scan bookkeeping on memories ─────────────────────────────────────────
alter table public.memories
  add column if not exists injection_scanned_at  timestamptz,
  add column if not exists scan_pattern_version  integer;

comment on column public.memories.injection_scanned_at is
  'When this row was last passed through the injection/exfil pattern set. NULL = never scanned (true of 785 rows before 2026-08-02). Advisory only — nothing in the recall path reads this.';
comment on column public.memories.scan_pattern_version is
  'threat-patterns.json version that last cleared this row. Behind the current version => memory-injection-rescan.timer picks it up. This is what makes pattern additions retroactive.';

-- Rescan worker's driving query is "scan_pattern_version is null or < current",
-- so NULLS FIRST matches the scan order it wants.
create index if not exists idx_memories_scan_pattern_version
  on public.memories (scan_pattern_version nulls first)
  where is_active;

-- ── 2. Findings / review table ──────────────────────────────────────────────
-- One row per (memory, field, threat) so a re-scan under the same pattern set is
-- idempotent and a reviewer's verdict survives every later scan.
create table if not exists public.memory_scan_findings (
  id                 uuid primary key default gen_random_uuid(),
  memory_id          uuid not null references public.memories(id) on delete cascade,
  field              text not null check (field in ('name','description','content')),
  threat_id          text not null,
  severity           text not null default 'medium'
                       check (severity in ('high','medium','low')),
  pattern_version    integer not null,
  match_text         text,          -- the literal substring that matched
  excerpt            text,          -- ~200 chars of surrounding context for review
  status             text not null default 'pending'
                       check (status in ('pending','confirmed','false_positive','accepted_risk')),
  first_detected_at  timestamptz not null default now(),
  last_detected_at   timestamptz not null default now(),
  reviewed_at        timestamptz,
  reviewed_by        text,
  review_note        text,
  constraint memory_scan_findings_uniq unique (memory_id, field, threat_id)
);

comment on table public.memory_scan_findings is
  'OWASP ASI06 interception point 4 — post-hoc injection findings awaiting human review. A row here is an ALLEGATION, not a verdict: nothing reads this table at recall time and no job quarantines from it. Triage with resolve_scan_finding().';

create index if not exists idx_scan_findings_pending
  on public.memory_scan_findings (severity, last_detected_at desc)
  where status = 'pending';
create index if not exists idx_scan_findings_memory
  on public.memory_scan_findings (memory_id);

alter table public.memory_scan_findings enable row level security;

-- Service role only, matching the other governance tables. No anon/authenticated
-- policy: this table quotes attacker-controlled text verbatim in `excerpt`.
drop policy if exists memory_scan_findings_service on public.memory_scan_findings;
create policy memory_scan_findings_service
  on public.memory_scan_findings
  for all
  to service_role
  using (true) with check (true);

-- ── 3. Review queue view ────────────────────────────────────────────────────
create or replace view public.memory_injection_review_queue as
select
  f.id            as finding_id,
  f.severity,
  f.threat_id,
  f.field,
  f.match_text,
  f.excerpt,
  f.pattern_version,
  f.first_detected_at,
  m.id            as memory_id,
  m.name          as memory_name,
  m.type          as memory_type,
  m.writer_agent,
  m.source,
  m.trust_tier,
  m.created_at    as memory_created_at,
  m.is_active,
  (m.created_at < timestamptz '2026-07-21') as predates_write_time_gate
from public.memory_scan_findings f
join public.memories m on m.id = f.memory_id
where f.status = 'pending'
order by
  case f.severity when 'high' then 0 when 'medium' then 1 else 2 end,
  f.first_detected_at desc;

comment on view public.memory_injection_review_queue is
  'Pending injection-scan findings joined to memory provenance. predates_write_time_gate=true means the row was never scanned at write time (created before migration 076) — the population REC 1 exists to cover.';

-- ── 4. Triage RPC ───────────────────────────────────────────────────────────
-- Deliberately cannot set trust_tier. Marking a finding 'confirmed' records a
-- judgement; quarantining is a separate, explicit act by a human using the
-- existing governance tooling. Keeping those two operations apart is what stops
-- an automated triage pass from silently blanking rows out of recall.
create or replace function public.resolve_scan_finding(
  p_finding_id  uuid,
  p_status      text,
  p_reviewed_by text default 'human',
  p_note        text default null
) returns public.memory_scan_findings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.memory_scan_findings;
begin
  if p_status not in ('confirmed','false_positive','accepted_risk') then
    raise exception 'resolve_scan_finding: p_status must be confirmed | false_positive | accepted_risk, got %', p_status;
  end if;

  update public.memory_scan_findings
     set status      = p_status,
         reviewed_at = now(),
         reviewed_by = p_reviewed_by,
         review_note = p_note
   where id = p_finding_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'resolve_scan_finding: no finding with id %', p_finding_id;
  end if;

  return v_row;
end;
$$;

revoke all on function public.resolve_scan_finding(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_scan_finding(uuid, text, text, text) to service_role;

-- ── 5. Coverage reporting ───────────────────────────────────────────────────
create or replace function public.injection_scan_coverage(p_current_version integer)
returns table (
  total_active        bigint,
  never_scanned       bigint,
  behind_version      bigint,
  current_version_ok  bigint,
  pending_findings    bigint,
  confirmed_findings  bigint,
  last_scan_at        timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    (select count(*) from public.memories where is_active),
    (select count(*) from public.memories where is_active and scan_pattern_version is null),
    (select count(*) from public.memories where is_active and scan_pattern_version < p_current_version),
    (select count(*) from public.memories where is_active and scan_pattern_version >= p_current_version),
    (select count(*) from public.memory_scan_findings where status = 'pending'),
    (select count(*) from public.memory_scan_findings where status = 'confirmed'),
    (select max(injection_scanned_at) from public.memories);
$$;

revoke all on function public.injection_scan_coverage(integer) from public, anon, authenticated;
grant execute on function public.injection_scan_coverage(integer) to service_role;

commit;
