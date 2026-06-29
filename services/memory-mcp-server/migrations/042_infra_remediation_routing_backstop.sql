-- Migration 042: Infra-remediation routing backstop
-- ─────────────────────────────────────────────────────────────────────────
-- Problem: the Iris CCR "cowork-scheduler" on claude.ai converts inbound
-- alert emails (e.g. "[Homebridge] Down at ...", "[AMP Game Server] Down
-- at ...") into task_queue rows with source='cowork' AND target='cowork'.
-- Iris on Cowork has NO SSH/shell into svc-podman-01 and cannot restart
-- services, run podman/systemd, or touch LXC/VM/Proxmox. Such tasks stall
-- until a human notices — see task 573e86cd-e499-4cf0-8ed8-a22266834437
-- (2026-06-10 Homebridge+AMP Down) which sat ~11h before Jeff escalated.
--
-- Fix mechanism: the converter source code lives in an Iris CCR trigger
-- prompt on claude.ai (not on this host's filesystem). Same constraint as
-- migration 037 — we cannot edit the trigger from svc-podman-01. So we
-- add a DB-level BEFORE INSERT backstop that detects infra-remediation
-- signals and rewrites target='cowork' → target='claude-code'. This
-- enforces system_rule 'task_routing_infra_remediation' (priority 2,
-- added 2026-06-10) at the database boundary so no client can bypass it.
--
-- Routing policy (from system_rules.task_routing_infra_remediation):
--   - Infra/host remediation → target='claude-code' (wren)
--     Triggers: restart, down, crashed, service health, container, LXC,
--     VM, deploy, systemd, podman, proxmox, ssh, host
--     Plus any alert email subject containing "Down at" / "Up at" /
--     "[<service>] Down" / "unreachable" / "health"
--   - Research/planning/web-UI/content → target='cowork' (Iris) OK
--
-- Scope: trigger only rewrites when source='cowork' AND target='cowork'
-- AND signals match. Explicit non-cowork targets are never touched. This
-- lets Iris still send research/planning tasks to itself.

BEGIN;

-- ── Routing signal classifier ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.task_needs_host_remediation(
  p_title       text,
  p_description text,
  p_context     jsonb,
  p_tags        text[]
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_haystack text;
  v_alert_emails text;
BEGIN
  -- Concatenate searchable surface: title + description + alert_emails +
  -- tag list. Lowercase once.
  v_alert_emails := COALESCE(
    (SELECT string_agg(value::text, ' ')
       FROM jsonb_array_elements_text(
              COALESCE(p_context->'alert_emails', '[]'::jsonb))),
    ''
  );

  v_haystack := lower(
    COALESCE(p_title, '') || ' ' ||
    COALESCE(p_description, '') || ' ' ||
    v_alert_emails || ' ' ||
    COALESCE(array_to_string(p_tags, ' '), '')
  );

  -- Word-boundary matches for infra-remediation triggers. Order is
  -- cheapest-first; bail on first hit. Patterns are deliberately broad —
  -- false positives just route to Wren who has full capability.
  RETURN
       v_haystack ~ '\m(down|crashed|unreachable|offline)\M'
    OR v_haystack ~ '\mrestart\M'
    OR v_haystack ~ '\m(service\s+health|health\s*check|healthcheck)\M'
    OR v_haystack ~ '\m(container|podman|docker)\M'
    OR v_haystack ~ '\m(lxc|vm|proxmox)\M'
    OR v_haystack ~ '\m(systemd|systemctl)\M'
    OR v_haystack ~ '\mdeploy(ed|ment)?\M'
    OR v_haystack ~ '\m(ssh|host[- ]side)\M'
    OR v_haystack ~ '\mup\s+at\M'   -- recovery alert ("[svc] Up at …")
    OR v_haystack ~ '\bhomebridge\b'
    OR v_haystack ~ '\bamp\s+(game\s+)?server\b'
    OR v_haystack ~ '\buptime[- ]?kuma\b';
END;
$$;

-- ── BEFORE INSERT trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_infra_remediation_routing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only rewrite when both source AND target are 'cowork' — i.e. Iris's
  -- cowork-scheduler self-targeted. Any caller that explicitly picked a
  -- non-cowork target is honoring routing intent; leave alone.
  IF NEW.source = 'cowork'
     AND NEW.target = 'cowork'
     AND public.task_needs_host_remediation(
           NEW.title, NEW.description, NEW.context, NEW.tags)
  THEN
    NEW.target := 'claude-code';

    -- Annotate context so the downstream poller / Discord notification
    -- shows why this was re-routed. Non-destructive merge.
    NEW.context := COALESCE(NEW.context, '{}'::jsonb)
      || jsonb_build_object(
           'routing_override', jsonb_build_object(
             'from',   'cowork',
             'to',     'claude-code',
             'reason', 'infra_remediation_backstop',
             'rule',   'task_routing_infra_remediation',
             'at',     to_jsonb(now())
           )
         );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_infra_remediation_routing
  ON public.task_queue;

CREATE TRIGGER trg_enforce_infra_remediation_routing
  BEFORE INSERT ON public.task_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_infra_remediation_routing();

REVOKE EXECUTE ON FUNCTION public.task_needs_host_remediation(text, text, jsonb, text[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_infra_remediation_routing() FROM anon, authenticated;

COMMIT;
