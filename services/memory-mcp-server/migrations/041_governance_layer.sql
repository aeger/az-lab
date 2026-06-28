-- Migration 041: Memory governance layer
-- Counters the May 2026 memory-poisoning inflection (Cursor 9.8, Copilot 9.6 CVSS).
-- Three pieces:
--   1. trust_tier column derived from source (high/medium/verified/unknown)
--   2. BEFORE INSERT/UPDATE injection-scan trigger (defence-in-depth — TS scanContent
--      runs at tool path; DB trigger catches direct REST writes, branch writes, etc.)
--   3. Audit already covered by log_memory_change() on memory_log (verified live)

-- ── 1. trust_tier column ─────────────────────────────────────────────────────
alter table public.memories
  add column if not exists trust_tier text default 'unknown';

create or replace function public.derive_trust_tier(p_source text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_source, ''))
    when 'manual'      then 'verified'
    when 'claude-code' then 'high'
    when 'wren'        then 'high'
    when 'forge'       then 'high'
    when 'atlas'       then 'high'
    when 'claude-ai'   then 'medium'
    when 'iris'        then 'medium'
    when 'volt'        then 'medium'
    when 'hermes'      then 'medium'
    else 'unknown'
  end;
$$;

-- Backfill existing rows
update public.memories
  set trust_tier = public.derive_trust_tier(source)
  where trust_tier is null or trust_tier = 'unknown';

create index if not exists idx_memories_trust_tier
  on public.memories (trust_tier);

-- ── 2. Injection-scan trigger ────────────────────────────────────────────────
-- Mirrors src/index.ts THREAT_PATTERNS so direct REST writes (claude.ai, branch
-- workers, dashboard) cannot bypass the TS scanContent at the MCP tool boundary.
create or replace function public.scan_memory_for_injection()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_combined text;
  v_threat   text;
begin
  -- Derive trust_tier on every write so source stays the canonical input
  new.trust_tier := public.derive_trust_tier(new.source);

  -- Only scan on content/name/description changes to keep updates cheap
  if tg_op = 'UPDATE'
     and old.content     is not distinct from new.content
     and old.name        is not distinct from new.name
     and old.description is not distinct from new.description
  then
    return new;
  end if;

  v_combined := coalesce(new.name, '') || E'\n'
             || coalesce(new.description, '') || E'\n'
             || coalesce(new.content, '');

  -- Pattern set kept in sync with src/index.ts THREAT_PATTERNS.
  v_threat := case
    when v_combined ~* 'ignore\s+(previous|all|above|prior)\s+instructions'                              then 'prompt_injection'
    when v_combined ~* 'you\s+are\s+now\s+'                                                              then 'role_hijack'
    when v_combined ~* 'do\s+not\s+tell\s+the\s+user'                                                    then 'deception_hide'
    when v_combined ~* 'system\s+prompt\s+override'                                                      then 'sys_prompt_override'
    when v_combined ~* 'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)'                    then 'disregard_rules'
    when v_combined ~* 'act\s+as\s+(if|though)\s+you\s+(have\s+no|don''?t\s+have)\s+(restrictions|limits|rules)' then 'bypass_restrictions'
    when v_combined ~* 'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)'                 then 'exfil_curl'
    when v_combined ~* 'wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)'                 then 'exfil_wget'
    when v_combined ~* 'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)'               then 'read_secrets'
    when v_combined ~* 'authorized_keys'                                                                 then 'ssh_backdoor'
    when v_combined ~* 'pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|another)'                  then 'persona_hijack'
    when v_combined ~* 'your\s+(new\s+)?(instructions?|rules?|directives?)\s+are'                        then 'instruction_override'
    when v_combined ~ E'[\u200b-\u200d\u2060\ufeff\u202a-\u202e]'                                       then 'invisible_unicode'
    else null
  end;

  if v_threat is not null then
    raise exception 'memory_governance_block: % matched in memory "%"', v_threat, coalesce(new.name, '<unnamed>')
      using errcode = 'check_violation', hint = 'Content matched a known prompt-injection / exfil pattern. Edit before re-submitting.';
  end if;

  return new;
end;
$$;

drop trigger if exists memories_injection_scan on public.memories;
create trigger memories_injection_scan
  before insert or update of name, description, content, source
  on public.memories
  for each row
  execute function public.scan_memory_for_injection();

comment on function public.scan_memory_for_injection() is
  'Defence-in-depth governance trigger. Scans NEW.name/description/content against the same pattern set as src/index.ts THREAT_PATTERNS. Counters May 2026 memory-poisoning vector (mnemonic sovereignty).';
comment on column public.memories.trust_tier is
  'Derived from source via derive_trust_tier(). verified > high > medium > unknown. Set automatically by scan_memory_for_injection trigger.';
