-- 128: give task_queue_health a severity-by-CLASS axis, not age only
-- ────────────────────────────────────────────────────────────────────
-- MEASURED 2026-08-24 (first-hand, this database):
--   14 rows open at status='pending_jeff_action'. 11 of them carry a non-empty
--   `result` — the engineering is DONE and only a human acknowledgement is
--   outstanding. task_queue_health LISTED all 14 and PROMOTED exactly 1
--   (reason IS NOT NULL). Thirteen rows were scanned, printed, and dropped.
--
-- MECHANISM (110:55-56, restated verbatim at 118:68-69):
--     WHEN t.status = 'pending_jeff_action'
--          AND now() - t.created_at > make_interval(days => cfg.jeff_action_days)
--   jeff_action_days = 14. AGE IS THE ONLY AXIS. A row that finished its
--   engineering ten minutes ago and a row nobody has looked at are treated
--   identically for fourteen days, because the only property either is tested
--   on is how long it has existed.
--
-- AND THE AGE AXIS DOES NOT RESCUE IT EITHER. 84fc347c (created 2026-04-30,
--   116.1d) IS promoted, reason='awaiting_jeff', alert_count=31, and
--   net._http_response records HTTP 204 for the delivery at 2026-08-24 16:07.
--   Detector fired, delivery succeeded, state never changed. So the failure is
--   not "the threshold is too high" — raising or lowering a single age number
--   cannot separate "finished, needs one ack" from "nobody has started this".
--   Only a class axis can.
--
-- PROVENANCE, stated because it is the uncomfortable part: 121:96 sets
--   NEW.status := 'pending_jeff_action'. That is, v20.1 fixed review_needed's
--   rot by REDIRECTING it here (118 retired the status, 121 constrained the
--   writer). The destination's own drain rate was never measured. It is
--   0/13 on the class this migration names. Third occurrence of "a done-but-
--   open row is invisible": 035 (recurring rows, target filter), 118
--   (review_needed, no CASE arm), now this.
--
-- PRECEDENT COPIED: commit 854630a, git_durability_audit.py. Same defect
--   exactly — DIRTY_MAX_AGE_D=3 was that audit's only axis, so two migrations
--   ALREADY APPLIED to production were printed and then filtered out as "1.9d
--   old". The fix there was (a) a finding CLASS that bypasses the age gate and
--   (b) printing the per-line DECISION, not just the input, so a later reader
--   can tell "considered and dismissed" from "never looked at". Both halves
--   are reproduced here. Everything that is not one of the named classes keeps
--   the age axis, unchanged.
--
-- CALIBRATION: arXiv 2606.02494 (FMEA severity classified by operational
--   impact rather than elapsed time) and arXiv 2607.04329 / HAS-Bench
--   (interaction cost as a first-class metric: an ack a human must give is a
--   cost that should be surfaced immediately, not amortised over a fortnight).
--   Receipt style is arXiv 2608.19303 — state the property tested and the
--   threshold applied, not merely the verdict.
--
-- SCOPE. Routing only. This does NOT add a status, does NOT auto-close or
--   auto-archive anything, and does NOT redesign the approval gate. Whether
--   the gate should exist at all is Jeff's call and is filed separately as
--   task 19dc9cd3 — which, note, this migration deliberately does NOT promote
--   (it carries no result and no class, so it correctly stays on the age axis).
--
-- Apply via scripts/apply_sql.sh (Management API).

BEGIN;

-- ───────────────────────────────────────────────────── the view: class, then age
-- Column order note: CREATE OR REPLACE VIEW may only APPEND columns, so
-- severity_class / result_present / decision go at the end. Existing readers
-- (task_queue_health_check, session-start queries) are unaffected.
CREATE OR REPLACE VIEW public.task_queue_health AS
WITH cfg AS (SELECT * FROM public.task_queue_alert_state WHERE id),
     open_ids AS (
       -- Used by the blocks_open_gap class below. Same open-set definition the
       -- view itself uses, so "still open" means one thing in this file.
       SELECT id FROM public.task_queue
        WHERE status NOT IN ('completed','cancelled','archived')
     )
SELECT t.id,
       t.title,
       t.status,
       t.target,
       t.claimed_by,
       t.created_at,
       t.updated_at,
       CASE
         WHEN t.status = 'failed'                                   THEN 'failed'
         WHEN t.status IN ('blocked','escalated','expired','pending_eval','review_needed')
                                                                    THEN 'attention'
         WHEN t.status IN ('claimed','in_progress_agent')
              AND now() - t.claimed_at > make_interval(hours => cfg.stuck_claim_hours)
                                                                    THEN 'stuck_claim'
         WHEN t.status IN ('ready','pending')
              AND now() - t.created_at > make_interval(days => cfg.rot_days)
                                                                    THEN 'rotted'
         -- CLASS AXIS (128). Checked BEFORE the age gate and bypassing it
         -- entirely: for these three classes there is no age at which the row
         -- is merely work-in-progress, so a grace period buys nothing and
         -- costs the whole delay.
         WHEN t.status = 'pending_jeff_action' AND cls.severity_class IS NOT NULL
                                                                    THEN cls.severity_class
         -- AGE AXIS, unchanged, for every pending_jeff_action row that matched
         -- no class. This is the arm that used to be the only one.
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
       EXTRACT(day FROM now() - t.created_at)::int AS age_days,
       cls.severity_class,
       p.c_ack AS result_present,
       -- ── the receipt ──────────────────────────────────────────────────────
       -- Printed for EVERY row, promoted or not, naming the property tested and
       -- the threshold applied. 854630a's lesson: an audit that prints only its
       -- input leaves a reader unable to distinguish a line that was weighed and
       -- dismissed from one that was never classified at all. That is precisely
       -- how 13 of 14 rows here looked "considered".
       CASE
         WHEN t.status = 'failed' THEN
           format('FINDING failed — tested status; status=failed is reported on sight (no age threshold)')
         WHEN t.status IN ('blocked','escalated','expired','pending_eval','review_needed') THEN
           format('FINDING attention — tested status; %L is in the attention set (no age threshold)', t.status)
         WHEN t.status IN ('claimed','in_progress_agent') THEN
           format('%s — tested age-since-claim; %s vs stuck_claim_hours=%sh',
                  CASE WHEN now() - t.claimed_at > make_interval(hours => cfg.stuck_claim_hours)
                       THEN 'FINDING stuck_claim' ELSE 'hold' END,
                  CASE WHEN t.claimed_at IS NULL THEN 'claimed_at NULL (untestable)'
                       ELSE round(EXTRACT(epoch FROM now() - t.claimed_at)/3600.0, 1)::text || 'h' END,
                  cfg.stuck_claim_hours)
         WHEN t.status IN ('ready','pending') THEN
           format('%s — tested age-since-created; %sd vs rot_days=%sd',
                  CASE WHEN now() - t.created_at > make_interval(days => cfg.rot_days)
                       THEN 'FINDING rotted' ELSE 'hold' END,
                  EXTRACT(day FROM now() - t.created_at)::int, cfg.rot_days)
         WHEN t.status = 'pending_jeff_action' AND cls.severity_class IS NOT NULL THEN
           format('FINDING %s — tested class [result_present=%s(%s chars), security_gate=%s, blocks_open_gap=%s]; '
                  'age %sd IGNORED (class bypasses jeff_action_days=%sd)',
                  cls.severity_class, p.c_ack, length(coalesce(btrim(t.result),'')),
                  p.c_sec, p.c_gap,
                  EXTRACT(day FROM now() - t.created_at)::int, cfg.jeff_action_days)
         WHEN t.status = 'pending_jeff_action' THEN
           format('%s — no class matched [result_present=false, security_gate=%s, blocks_open_gap=%s]; '
                  'fell through to age axis: %sd vs jeff_action_days=%sd',
                  CASE WHEN now() - t.created_at > make_interval(days => cfg.jeff_action_days)
                       THEN 'FINDING awaiting_jeff' ELSE 'hold' END,
                  p.c_sec, p.c_gap,
                  EXTRACT(day FROM now() - t.created_at)::int, cfg.jeff_action_days)
         ELSE
           format('hold — status %L matches no CASE arm; scanned but unclassified '
                  '(this is the 118 failure mode: reason NULL reads as healthy)', t.status)
       END AS decision
  FROM public.task_queue t
  CROSS JOIN cfg
  -- The three class predicates, computed once and reused by reason AND decision
  -- so the receipt can never drift from the verdict it explains.
  CROSS JOIN LATERAL (
    SELECT
      -- ack_only: engineering finished, only a human ack is outstanding. This
      -- is the 11/14 case measured above.
      (coalesce(btrim(t.result), '') <> '')                                   AS c_ack,
      -- security_gate: a kill-switch / security-class row. An un-adjudicated
      -- safety control is the highest-impact thing that can sit in this lane;
      -- a 14-day window on it is the control being off for 14 days.
      -- coalesce() is load-bearing: failure_mode IS NULL for most rows and
      -- `false OR NULL` evaluates to NULL, not false, in SQL's three-valued
      -- logic. Without it this column reads NULL (verified against live data
      -- before this migration was written) and any later NOT on it inverts to
      -- NULL rather than true.
      coalesce(t.title ~* '\[KILL SWITCH\]'
               OR t.title ~* '(^|[^[:alnum:]])(security|credential|secret|rls|injection|exposed|leak)([^[:alnum:]]|$)'
               OR t.failure_mode = 'silent_agent', false)                     AS c_sec,
      -- blocks_open_gap: this row names another task that is ITSELF still
      -- open, i.e. it is a fix for a standing gap. Holding it holds that gap
      -- too, so its cost is not its own age. Matched on the 8-hex id prefix
      -- that queue rows conventionally cite, with boundary anchors so a bare
      -- substring cannot collide.
      EXISTS (SELECT 1 FROM open_ids o
               WHERE o.id <> t.id
                 AND coalesce(t.title,'') || ' ' || coalesce(t.description,'')
                     ~ ('(^|[^[:alnum:]])' || left(o.id::text, 8) || '([^[:alnum:]]|$)')) AS c_gap
  ) p
  -- Severity precedence, FMEA-style (impact first, not recency):
  --   security_gate   an off safety control
  --   blocks_open_gap holds a second open row hostage
  --   ack_only        done; costs one human ack
  CROSS JOIN LATERAL (
    SELECT CASE WHEN t.status <> 'pending_jeff_action' THEN NULL
                WHEN p.c_sec THEN 'security_gate'
                WHEN p.c_gap THEN 'blocks_open_gap'
                WHEN p.c_ack THEN 'ack_only'
           END AS severity_class
  ) cls
 WHERE t.status NOT IN ('completed','cancelled','archived');

COMMENT ON VIEW public.task_queue_health IS
  'Tasks needing attention. Severity is a function of CLASS as well as age (128). '
  'pending_jeff_action rows promote IMMEDIATELY, bypassing jeff_action_days, when they '
  'carry a non-empty result (ack_only -- engineering done, only a human ack outstanding), '
  'are a kill-switch/security row (security_gate), or name a still-open task (blocks_open_gap). '
  'Everything else keeps the age axis: failed and blocked/escalated/review_needed on sight, '
  'claims past stuck_claim_hours, ready/pending rot past rot_days, remaining '
  'pending_jeff_action past jeff_action_days. The `decision` column is a per-row RECEIPT: it '
  'names the property tested and the threshold applied for EVERY row, promoted or not, so a '
  'reader can tell a row that was weighed and dismissed from one that was never classified. '
  'age_days is measured from created_at -- updated_at is bulk-touched and cannot be trusted. '
  'Thresholds live in task_queue_alert_state. reason IS NULL means healthy.';

-- ────────────────────────────────────────── the check: name the class, count the acks
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
  v_ack     int;
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

  -- The count this alert previously could not say out loud. 11 of 14
  -- pending_jeff_action rows were finished-but-unacked on 2026-08-24 and the
  -- digest named none of them, because none was promoted. Counted from the
  -- PROMOTED set, so it is always a number the reader can act on directly.
  SELECT count(*) INTO v_ack
    FROM public.task_queue_health
   WHERE reason IS NOT NULL AND result_present AND status = 'pending_jeff_action';

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
    RETURN jsonb_build_object('action', 'suppressed', 'count', v_n, 'awaiting_ack', v_ack);
  END IF;

  FOR v_rows IN
    SELECT reason, status, title, age_days, target
      FROM public.task_queue_health
     WHERE reason IS NOT NULL
     ORDER BY CASE reason
                WHEN 'failed'          THEN 1
                WHEN 'attention'       THEN 2
                WHEN 'security_gate'   THEN 3
                WHEN 'stuck_claim'     THEN 4
                WHEN 'blocks_open_gap' THEN 5
                WHEN 'ack_only'        THEN 6
                WHEN 'awaiting_jeff'   THEN 7
                ELSE 8 END,
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

  -- The ack count goes in the HEADER, above the row list, on purpose: the body
  -- is truncated at 1900 chars for Discord and ack_only rows sort near the
  -- bottom, so a line placed after the list is exactly the line that gets cut.
  v_msg := format(
    E':clipboard: **task_queue needs attention — %s task(s)**\n%s%s%s'
    '_Cloud-side digest (Supabase pg_cron + pg_net). Re-reminds every %sh while unchanged; '
    'pages immediately when the set changes. Severity is by CLASS as well as age (mig 128) — '
    '`SELECT reason, decision FROM task_queue_health WHERE reason IS NOT NULL;` for the per-row receipt._',
    v_n,
    CASE WHEN v_ack > 0
         THEN format(E':white_check_mark: **%s finished-but-unacked** — engineering is DONE on these; they need only your acknowledgement, not work.\n', v_ack)
         ELSE '' END,
    v_lines,
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

  RETURN jsonb_build_object('action', 'alert', 'count', v_n,
                            'awaiting_ack', v_ack, 'scan_findings', v_scan);
END;
$function$;

REVOKE ALL ON FUNCTION public.task_queue_health_check() FROM public, anon, authenticated;

COMMIT;
