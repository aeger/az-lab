-- 110: Cloud-side task_queue failure + staleness surfacing (Tier 2, research 2026-08-09)
--
-- WHY: task_queue_attention only covers blocked/escalated/expired/pending_eval and
-- nothing ever reads it on a schedule. Research 2026-08-09 found a task that went
-- status='failed' on 08-07 with nobody ever seeing it, three research-implementation
-- tasks stuck in pending_jeff_action (two never even claimed), and two 'ready' Discord
-- tasks unclaimed since 2026-04-30 — 100 days.
--
-- Runs entirely cloud-side (pg_cron + pg_net -> Discord), same substrate as
-- fleet_deadman_check (migration: fleet-deadman-switch), so it still reports when
-- svc-podman-01 is dark. Digest-style with signature suppression: it pages when the
-- SET of offending tasks changes, and otherwise re-reminds only every digest_hours.
-- Rot is a standing condition; a 6-hourly repage of the same 100-day-old row is noise.

-- ---------------------------------------------------------------- state
CREATE TABLE IF NOT EXISTS public.task_queue_alert_state (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled            boolean     NOT NULL DEFAULT true,
  stuck_claim_hours  integer     NOT NULL DEFAULT 12,   -- claimed/in_progress, no update
  rot_days           integer     NOT NULL DEFAULT 7,    -- unclaimed ready/pending
  jeff_action_days   integer     NOT NULL DEFAULT 14,   -- pending_jeff_action nag
  digest_hours       integer     NOT NULL DEFAULT 24,   -- re-remind cadence, unchanged set
  last_signature     text,
  last_check_at      timestamptz,
  last_alert_at      timestamptz,
  alert_count        integer     NOT NULL DEFAULT 0
);
INSERT INTO public.task_queue_alert_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.task_queue_alert_state ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- the view
-- Everything that should have a human or agent looking at it but does not.
-- Deliberately wider than task_queue_attention: that view is status-only and
-- misses failures and time-based rot, which is exactly what went unseen.
CREATE OR REPLACE VIEW public.task_queue_health AS
WITH cfg AS (SELECT * FROM public.task_queue_alert_state WHERE id)
SELECT t.id,
       t.title,
       t.status,
       t.target,
       t.claimed_by,
       t.created_at,
       t.updated_at,
       CASE
         WHEN t.status = 'failed'                                   THEN 'failed'
         WHEN t.status IN ('blocked','escalated','expired','pending_eval')
                                                                    THEN 'attention'
         WHEN t.status IN ('claimed','in_progress_agent')
              AND now() - t.claimed_at > make_interval(hours => cfg.stuck_claim_hours)
                                                                    THEN 'stuck_claim'
         WHEN t.status IN ('ready','pending')
              AND now() - t.created_at > make_interval(days => cfg.rot_days)
                                                                    THEN 'rotted'
         WHEN t.status = 'pending_jeff_action'
              AND now() - t.created_at > make_interval(days => cfg.jeff_action_days)
                                                                    THEN 'awaiting_jeff'
       END AS reason,
       -- All ages measured from created_at. updated_at is NOT usable as a staleness
       -- signal here: a bulk touch on 2026-08-11 reset it across every open row, which
       -- would have rendered 106-day-old rot as age_days = 0. Likewise the rot predicate
       -- deliberately ignores claimed_at -- tasks that were claimed once and fell back to
       -- 'ready' matched neither the claimed_at IS NULL rot test nor the stuck-claim test,
       -- so they were invisible to both.
       EXTRACT(day FROM now() - t.created_at)::int AS age_days
  FROM public.task_queue t, cfg
 WHERE t.status NOT IN ('completed','cancelled','archived');

COMMENT ON VIEW public.task_queue_health IS
  'Tasks needing attention: failures, blocked/escalated, claims stuck past stuck_claim_hours, '
  'ready/pending rot past rot_days, pending_jeff_action past jeff_action_days. age_days is '
  'measured from created_at -- updated_at is bulk-touched and cannot be trusted. Thresholds '
  'live in task_queue_alert_state. reason IS NULL means healthy.';

-- Scheduled cloud-side: cron.schedule('task-queue-health', '7 * * * *',
--   $$SELECT public.task_queue_health_check();$$)  -- jobid 7

-- ---------------------------------------------------------------- the check
CREATE OR REPLACE FUNCTION public.task_queue_health_check()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'vault', 'extensions'
AS $function$
DECLARE
  st        public.task_queue_alert_state;
  v_rows    record;
  v_sig     text;
  v_hook    text;
  v_msg     text;
  v_lines   text := '';
  v_n       int;
  v_scan    int;
  v_reason_forced boolean := false;
BEGIN
  SELECT * INTO st FROM public.task_queue_alert_state WHERE id;
  IF NOT FOUND OR NOT st.enabled THEN
    RETURN jsonb_build_object('action', 'disabled');
  END IF;

  UPDATE public.task_queue_alert_state SET last_check_at = now() WHERE id;

  SELECT count(*),
         md5(string_agg(id::text || ':' || reason, ',' ORDER BY id::text))
    INTO v_n, v_sig
    FROM public.task_queue_health WHERE reason IS NOT NULL;

  -- Post-hoc memory audit findings ride the same digest rather than opening a
  -- second alert path (see migration 111).
  SELECT count(*) INTO v_scan
    FROM public.memory_scan_findings WHERE status = 'pending';

  IF v_n = 0 AND v_scan = 0 THEN
    UPDATE public.task_queue_alert_state SET last_signature = NULL WHERE id;
    RETURN jsonb_build_object('action', 'clean');
  END IF;

  v_sig := md5(coalesce(v_sig, '') || ':scan=' || v_scan);

  -- Suppress an unchanged set until digest_hours have passed.
  IF st.last_signature IS DISTINCT FROM v_sig THEN
    v_reason_forced := true;
  ELSIF st.last_alert_at IS NULL
        OR now() - st.last_alert_at > make_interval(hours => st.digest_hours) THEN
    v_reason_forced := true;
  END IF;

  IF NOT v_reason_forced THEN
    RETURN jsonb_build_object('action', 'suppressed', 'count', v_n);
  END IF;

  FOR v_rows IN
    SELECT reason, status, title, age_days, target
      FROM public.task_queue_health
     WHERE reason IS NOT NULL
     ORDER BY CASE reason
                WHEN 'failed'        THEN 1
                WHEN 'attention'     THEN 2
                WHEN 'stuck_claim'   THEN 3
                WHEN 'awaiting_jeff' THEN 4
                ELSE 5 END,
              age_days DESC
     LIMIT 15
  LOOP
    v_lines := v_lines || format(E'• `%s` **%s** — %s _(%s, %sd, →%s)_\n',
                 v_rows.reason, v_rows.status,
                 left(coalesce(v_rows.title, '<untitled>'), 80),
                 coalesce(v_rows.status, '?'), v_rows.age_days,
                 coalesce(v_rows.target, 'unassigned'));
  END LOOP;

  IF v_n > 15 THEN
    v_lines := v_lines || format(E'…and %s more.\n', v_n - 15);
  END IF;

  v_msg := format(
    E':clipboard: **task_queue needs attention — %s task(s)**\n%s%s'
    '_Cloud-side digest (Supabase pg_cron + pg_net). Re-reminds every %sh while unchanged; '
    'pages immediately when the set changes. `SELECT * FROM task_queue_health WHERE reason IS NOT NULL;`_',
    v_n, v_lines,
    CASE WHEN v_scan > 0
         THEN format(E':mag: **%s pending memory scan finding(s)** — `SELECT * FROM memory_scan_findings WHERE status=''pending'';`\n', v_scan)
         ELSE '' END,
    st.digest_hours);

  SELECT decrypted_secret INTO v_hook
    FROM vault.decrypted_secrets WHERE name = 'fleet_deadman_discord_webhook';
  IF v_hook IS NULL THEN
    RETURN jsonb_build_object('action', 'alert', 'error', 'webhook secret missing', 'count', v_n);
  END IF;

  PERFORM net.http_post(
    url     => v_hook,
    body    => jsonb_build_object('content', left(v_msg, 1900), 'username', 'az-lab task queue'),
    headers => '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds => 8000
  );

  UPDATE public.task_queue_alert_state
     SET last_signature = v_sig,
         last_alert_at  = now(),
         alert_count    = alert_count + 1
   WHERE id;

  RETURN jsonb_build_object('action', 'alert', 'count', v_n, 'scan_findings', v_scan);
END;
$function$;

REVOKE ALL ON FUNCTION public.task_queue_health_check() FROM public, anon, authenticated;
