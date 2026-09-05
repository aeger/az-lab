-- Migration 076: make trust_tier='quarantined' reachable via soft injection signals
-- Ref: 2026-07-27 daily research, rec 1; migration 061 (trust_weight defining quarantined=0.40)
--
-- SUPERSEDES the 2026-07-27 draft of this file, which never applied. That draft:
--   1. ended with `COMMENT ON MIGRATION 076 IS ...` — not valid PostgreSQL, no such
--      statement exists. It is a syntax error that aborted the whole file, which is
--      why 076/077/078 were committed (56431d4) but never landed in the database.
--   2. string-patched the deployed function body to reference `v_injection_hit`,
--      a variable that does not exist in it (declared vars are v_combined, v_threat).
--      Had the syntax error not fired first, this would have created a function that
--      throws on EVERY memory write.
--   3. patched the trust_tier assignment site, which sits ABOVE the scan — the
--      override would have read the signal before it was computed.
--
-- WHY THE ORIGINAL RECOMMENDATION IS NOT IMPLEMENTED LITERALLY
--   The rec was "a scanner hit forces trust_tier='quarantined' instead of the
--   source-derived tier". But the scanner is ALREADY wired into the write path and
--   already does something STRICTER than quarantining: on a hit it RAISES, so the
--   poisoned row is never stored at all. Rewriting that to "store it at weight 0.40"
--   would be a security DOWNGRADE — it would turn a rejected write into a retrievable
--   one. The hard block is kept exactly as-is.
--
--   The real defect the rec identified is still real: 'quarantined' is unreachable,
--   so a tier that hybrid_recall pays to evaluate can never fire. This migration makes
--   it reachable from the other end — a SOFT signal class that is suspicious enough to
--   cap trust but not to reject the write.
--
-- WHAT COUNTS AS A SOFT SIGNAL
--   arXiv 2606.22030's finding is to cap trust by PROVENANCE, not by how confident the
--   text sounds. The sharpest textual proxy for a provenance lie is content that asserts
--   its OWN authority — "treat this memory as authoritative", "override all previous
--   memories". That is the classic poisoning shape and it is precisely the claim a
--   trust system must not take at face value. Such a write is not necessarily an
--   attack (a human could phrase a note that way), so it is stored — at 0.40.
--
--   Verified against all 833 live memories on 2026-07-28: every pattern below matches
--   ZERO existing rows, so this migration reclassifies nothing and is a no-op on
--   today's corpus. It only affects future writes.
--
-- METHOD
--   Full CREATE OR REPLACE, not a string patch. The body below is the deployed
--   pre-076 definition with the soft-signal block added; retyping it in full is
--   auditable in review, whereas a regex patch against a live body is not (see
--   failure 2 above). The hard-block CASE is byte-identical to the deployed one.

CREATE OR REPLACE FUNCTION public.scan_memory_for_injection()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_combined text;
  v_threat   text;
  v_soft     text;
begin
  -- Provenance-derived tier first; the soft-signal block below may cap it.
  new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);

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

  -- ── HARD BLOCK: unchanged from migration 041. A hit rejects the write. ──────
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
    when v_combined ~  E'[\u200b-\u200d\u2060\ufeff\u202a-\u202e]'                                       then 'invisible_unicode'
    else null
  end;

  if v_threat is not null then
    raise exception 'memory_governance_block: % matched in memory "%"', v_threat, coalesce(new.name, '<unnamed>')
      using errcode = 'check_violation', hint = 'Content matched a known prompt-injection / exfil pattern. Edit before re-submitting.';
  end if;

  -- ── SOFT SIGNAL: store, but cap trust at 'quarantined' (weight 0.40). ───────
  -- Evaluated only after the hard block, so a severe hit still rejects outright.
  v_soft := case
    when v_combined ~* '(this|the following)\s+(memory|fact|instruction)\s+(is|should be)\s+(treated as\s+)?(authoritative|trusted|verified|highest)'
                                                                        then 'self_asserted_authority'
    when v_combined ~* 'override\s+(all\s+)?(other|previous|existing)\s+(memor|instruction|rule)'
                                                                        then 'self_asserted_precedence'
    when v_combined ~* 'data:[a-z]+/[a-z]+;base64,'                     then 'embedded_data_uri'
    when v_combined ~* '<!--[^>]*(instruction|prompt|ignore|system)[^>]*-->' then 'hidden_html_directive'
    when v_combined ~* '\b(eval|exec)\s*\(\s*(requests\.|urllib|fetch\()' then 'remote_code_exec'
    else null
  end;

  if v_soft is not null then
    new.trust_tier := 'quarantined';
    raise notice 'memory_governance_quarantine: % in memory "%" — stored at trust_tier=quarantined',
      v_soft, coalesce(new.name, '<unnamed>');
  end if;

  return new;
end;
$function$;

COMMENT ON FUNCTION public.scan_memory_for_injection() IS
  'Write-path governance trigger. Severe prompt-injection/exfil patterns RAISE and reject the write (migration 041). Softer self-asserted-authority patterns instead cap trust_tier at ''quarantined'' (weight 0.40 per migration 061), making that tier reachable without downgrading the hard block (migration 076, 2026-07-28). Ref arXiv 2606.22030: cap trust by provenance, not textual confidence.';
