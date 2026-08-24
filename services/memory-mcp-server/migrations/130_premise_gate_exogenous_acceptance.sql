-- 130: the premise gate — an acceptance signal the research runner cannot author
-- ─────────────────────────────────────────────────────────────────────────────
-- DECISION OF RECORD. Jeff, 2026-08-24, on task 19dc9cd3 ("premise validation —
-- the verify-gate checks LIVE, never NEEDED"): "yes set this up. you can ask
-- heather too." The question this answers was filed, deliberately, OUTSIDE the
-- run that discovered it (128 scope note: "Whether the gate should exist at all
-- is Jeff's call and is filed separately as task 19dc9cd3"). The gate's
-- EXISTENCE is therefore exogenous; only its mechanism is agent-authored, and
-- the mechanism is constrained below so that it cannot grade itself.
--
-- THE GAP. pending_jeff_action is a real, working human verify-gate — but it
-- asks whether a change is LIVE, never whether it was NEEDED. On 2026-08-21 two
-- engineering tasks (7291f07e, a18679f8) were correctly implemented against a
-- FALSE premise and both would have passed it. The 'Daily Research Agent — Task
-- Definition' correction log is a SELF-AUTHORED acceptance test: the runner
-- writes the recommendation, writes the correction that scores it, and writes
-- the criterion the next run reads.
--
-- NAMED, MEASURED, PRESCRIBED. arXiv 2607.24300 calls this the VERIFIER-
-- DEPLOYMENT GAP: when an agent controls both the policy it edits and the test
-- that accepts the edit, the two diverge. 7 model families x Atari x 10 rounds:
-- all 35 combinations self-scored >= 0.70, yet 15/35 (43%) DEPLOYED BELOW the
-- random reference; six hit the floor with near-perfect self-scores. Tightening
-- the self-check (monotone/discriminative constraints) did not close the gap and
-- sometimes widened it — a better self-check is NOT the fix. Their remedy (SEAL)
-- needs no supervisor model, only four conditions. Deployment 30.0 vs 9.0.
--
-- SEAL's four conditions, and exactly how each is enforced here:
--   1. EXOGENOUS AUDIT     auditor identity is CHECK-constrained to a non-runner
--                          ('jeff','heather','volt','iris'). Wren/Atlas/claude-
--                          code — the agents that can write the task definition
--                          and the recommendation — are rejected by the DB, not
--                          by convention.
--   2. CONFIDENTIALITY     the audit note and the auditor's reasoning live in
--                          schema `premise_audit`, which is REVOKEd from anon /
--                          authenticated / service_role and is NOT in PostgREST's
--                          exposed-schema list. The runner's read path cannot see
--                          it. HONEST LIMIT, stated because overclaiming it would
--                          reproduce the very failure: an agent holding the
--                          Management-API PAT or the Supabase MCP can still read
--                          the schema directly. This is confidentiality against
--                          the AUTOMATED path, not against a determined agent.
--   3. SINGLE-BIT FEEDBACK premise_gate_status() returns one of
--                          not_gated/pending/accept/reject and NOTHING else — no
--                          score, no rationale, no partial credit.
--   4. CONSERVATIVE UPDATE the gated row is parked at pending_jeff_action, which
--                          poll_queue does not claim (it claims ready/pending).
--                          Absent verdict == not deployed. A reject cancels.
--
-- WHY NOT A NEW STATUS. 118/121/128 are three consecutive write-ups of the same
-- failure: 'review_needed' was a status with no reader, so rows landed there and
-- rotted (846ff20e sat 105 days). This migration adds NO status. It reuses
-- pending_jeff_action, which has live readers (task_queue_health, task_queue_
-- attention, the dashboard's JEFF_URGENT rank), and adds a severity CLASS
-- `premise_hold` so a gated row bypasses jeff_action_days=14 and is promoted on
-- sight — a not-yet-started row has no age at which it is merely in progress.
--
-- SCOPE. Gates research-derived ENGINEERING rows only: source='claude-code',
-- tagged daily-research/research AND implementation/delegated, target <> 'jeff',
-- not tagged 'decision'. That is ~2-3 rows/day, all of which already required a
-- human. Nothing else in the queue changes.
--
-- CALIBRATION CAVEAT (arXiv 2606.09863): LLM judges cap at AUROC 0.65 on false
-- success while lightweight domain-calibrated detectors reach 0.83-0.95 — but
-- need 50-100 labelled examples per class to transfer. az-lab is the instructive
-- inverse: its detector WAS hand-written and domain-specific and still mis-fired
-- (v21's one-name-literal coverage check), because it was miscalibrated on its
-- own population. So this gate deliberately does NOT auto-judge. It routes to a
-- human/non-runner and records the bit. premise_audit.verdicts IS the labelled
-- corpus; revisit automation only when it holds 50+ rows per class.
--
-- Apply via scripts/apply_sql.sh (Management API) or Supabase MCP apply_migration.

BEGIN;

-- ───────────────────────────────────────────────────────── 1. private schema
CREATE SCHEMA IF NOT EXISTS premise_audit;
REVOKE ALL ON SCHEMA premise_audit FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON SCHEMA premise_audit FROM anon, authenticated, service_role';
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMENT ON SCHEMA premise_audit IS
  'SEAL condition 2 (confidentiality). Holds the premise claims and the auditor''s '
  'private reasoning for the premise gate (130). NOT exposed via PostgREST and '
  'REVOKEd from anon/authenticated/service_role, so the research runner''s normal '
  'read path cannot observe the audit. A holder of the Management API PAT can — '
  'this is confidentiality against the automated path, not against a determined agent.';

-- ─────────────────────────────────────────────────── 2. the claim (what was asserted)
CREATE TABLE IF NOT EXISTS premise_audit.claims (
  task_id        uuid PRIMARY KEY REFERENCES public.task_queue(id) ON DELETE CASCADE,
  title          text NOT NULL,
  premise        text,                      -- text after a 'PREMISE:' line, if the runner stated one
  premise_stated boolean NOT NULL DEFAULT false,
  gated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN premise_audit.claims.premise_stated IS
  'False = the runner never wrote a PREMISE: line. That is itself an audit finding: '
  'an unstated premise cannot be checked, so the correct verdict is reject.';

-- ─────────────────────────────────────────────── 3. the verdict (one bit, exogenous)
CREATE TABLE IF NOT EXISTS premise_audit.verdicts (
  task_id     uuid PRIMARY KEY REFERENCES public.task_queue(id) ON DELETE CASCADE,
  verdict     boolean NOT NULL,
  auditor     text NOT NULL,
  note        text,                          -- PRIVATE. never returned to the runner.
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premise_verdict_auditor_is_exogenous
    CHECK (auditor = ANY (ARRAY['jeff','heather','volt','iris']))
);
COMMENT ON CONSTRAINT premise_verdict_auditor_is_exogenous ON premise_audit.verdicts IS
  'SEAL condition 1. wren / atlas / claude-code are ABSENT by design: they are the '
  'agents that can write both the recommendation and the Daily Research task '
  'definition it is scored against. An agent grading its own premise is the defect.';

-- ───────────────────────────────────────── 4. the gate: park, do not deploy
CREATE OR REPLACE FUNCTION public.task_queue_premise_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tags text[] := coalesce(NEW.tags, ARRAY[]::text[]);
BEGIN
  IF NEW.source = 'claude-code'
     AND v_tags && ARRAY['daily-research','research']::text[]
     AND v_tags && ARRAY['implementation','delegated']::text[]
     AND NOT (v_tags && ARRAY['decision','premise-hold','premise-accepted']::text[])
     AND coalesce(NEW.target,'') <> 'jeff'
     AND coalesce(NEW.status,'pending') IN ('pending','ready','backlog','delegated')
  THEN
    NEW.status := 'pending_jeff_action';
    NEW.tags   := array_append(v_tags, 'premise-hold');
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.task_queue_premise_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, premise_audit, pg_temp
AS $$
DECLARE
  v_premise text;
BEGIN
  IF coalesce(NEW.tags, ARRAY[]::text[]) && ARRAY['premise-hold']::text[] THEN
    -- Everything after a line beginning PREMISE: (case-insensitive), up to a blank line.
    v_premise := (regexp_match(coalesce(NEW.description,''),
                               '(?ni)^\s*PREMISE:\s*(.+?)(?=\n\s*\n|\Z)'))[1];
    INSERT INTO premise_audit.claims (task_id, title, premise, premise_stated)
    VALUES (NEW.id, NEW.title, v_premise, v_premise IS NOT NULL)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_ab_task_queue_premise_gate ON public.task_queue;
CREATE TRIGGER trg_ab_task_queue_premise_gate
  BEFORE INSERT ON public.task_queue
  FOR EACH ROW EXECUTE FUNCTION public.task_queue_premise_gate();

DROP TRIGGER IF EXISTS trg_zz_task_queue_premise_claim ON public.task_queue;
CREATE TRIGGER trg_zz_task_queue_premise_claim
  AFTER INSERT ON public.task_queue
  FOR EACH ROW EXECUTE FUNCTION public.task_queue_premise_claim();

-- ───────────────────────────────── 5. single-bit read path (SEAL condition 3)
CREATE OR REPLACE FUNCTION public.premise_gate_status(p_task uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, premise_audit, pg_temp
AS $$
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM premise_audit.claims c WHERE c.task_id = p_task)
             THEN 'not_gated'
           WHEN NOT EXISTS (SELECT 1 FROM premise_audit.verdicts v WHERE v.task_id = p_task)
             THEN 'pending'
           WHEN (SELECT v.verdict FROM premise_audit.verdicts v WHERE v.task_id = p_task)
             THEN 'accept'
           ELSE 'reject'
         END
$$;
COMMENT ON FUNCTION public.premise_gate_status(uuid) IS
  'SEAL condition 3: one of not_gated/pending/accept/reject and nothing else. No score, '
  'no rationale, no partial credit — a richer signal is a signal the runner can optimise against.';

-- What the AUDITOR sees. Title + the runner''s own premise text only: nothing here is
-- secret from the runner (it wrote it), so this is safe in public.
CREATE OR REPLACE FUNCTION public.premise_pending()
RETURNS TABLE (task_id uuid, title text, premise text, premise_stated boolean, gated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, premise_audit, pg_temp
AS $$
  SELECT c.task_id, c.title, c.premise, c.premise_stated, c.gated_at
    FROM premise_audit.claims c
    LEFT JOIN premise_audit.verdicts v ON v.task_id = c.task_id
   WHERE v.task_id IS NULL
   ORDER BY c.gated_at
$$;

-- ───────────────────────────── 6. the decision (SEAL condition 4: reject blocks)
CREATE OR REPLACE FUNCTION public.premise_decide(
  p_task    uuid,
  p_accept  boolean,
  p_auditor text,
  p_note    text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, premise_audit, pg_temp
AS $$
DECLARE
  v_tags text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM premise_audit.claims WHERE task_id = p_task) THEN
    RAISE EXCEPTION 'premise_decide: task % is not premise-gated', p_task;
  END IF;

  INSERT INTO premise_audit.verdicts (task_id, verdict, auditor, note)
  VALUES (p_task, p_accept, lower(btrim(p_auditor)), p_note)
  ON CONFLICT (task_id) DO UPDATE
    SET verdict = EXCLUDED.verdict, auditor = EXCLUDED.auditor,
        note = EXCLUDED.note, decided_at = now();

  SELECT coalesce(tags, ARRAY[]::text[]) INTO v_tags FROM public.task_queue WHERE id = p_task;
  v_tags := array_remove(v_tags, 'premise-hold');

  IF p_accept THEN
    UPDATE public.task_queue
       SET status = 'ready',
           tags   = array_append(v_tags, 'premise-accepted')
     WHERE id = p_task;
    RETURN 'accept';
  ELSE
    UPDATE public.task_queue
       SET status = 'cancelled',
           tags   = array_append(v_tags, 'premise-rejected'),
           result = coalesce(result,'') ||
                    E'\n[premise gate] rejected by an exogenous auditor: the premise this ' ||
                    'recommendation rests on was not accepted. No engineering was performed. ' ||
                    'Rationale is held privately in premise_audit.verdicts (SEAL condition 2).'
     WHERE id = p_task;
    RETURN 'reject';
  END IF;
END $$;
COMMENT ON FUNCTION public.premise_decide(uuid, boolean, text, text) IS
  'The ONLY release path for a premise-held task. Auditor is CHECK-constrained to a '
  'non-runner. Accept -> ready; reject -> cancelled with no engineering done. The note '
  'is written to premise_audit (private) and never surfaced to the runner.';

-- ─────────────────── 7. give the hold a reader: severity class on task_queue_health
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
           format('FINDING %s — tested class [premise_hold=%s, result_present=%s(%s chars), security_gate=%s, blocks_open_gap=%s]; '
                  'age %sd IGNORED (class bypasses jeff_action_days=%sd)',
                  cls.severity_class, p.c_prem, p.c_ack, length(coalesce(btrim(t.result),'')),
                  p.c_sec, p.c_gap,
                  EXTRACT(day FROM now() - t.created_at)::int, cfg.jeff_action_days)
         WHEN t.status = 'pending_jeff_action' THEN
           format('%s — no class matched [premise_hold=false, result_present=false, security_gate=%s, blocks_open_gap=%s]; '
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
                     ~ ('(^|[^[:alnum:]])' || left(o.id::text, 8) || '([^[:alnum:]]|$)')) AS c_gap,
      -- premise_hold (130): the row has not STARTED. It is parked by the
      -- premise gate and costs exactly one exogenous accept/reject bit. The
      -- age axis is actively wrong for it: 14 days of silence is 14 days of a
      -- research recommendation neither validated nor discarded.
      coalesce(t.tags && ARRAY['premise-hold']::text[], false)                AS c_prem
  ) p
  -- Severity precedence, FMEA-style (impact first, not recency):
  --   security_gate   an off safety control
  --   blocks_open_gap holds a second open row hostage
  --   ack_only        done; costs one human ack
  CROSS JOIN LATERAL (
    SELECT CASE WHEN t.status <> 'pending_jeff_action' THEN NULL
                WHEN p.c_sec THEN 'security_gate'
                WHEN p.c_prem THEN 'premise_hold'
                WHEN p.c_gap THEN 'blocks_open_gap'
                WHEN p.c_ack THEN 'ack_only'
           END AS severity_class
  ) cls
 WHERE t.status NOT IN ('completed','cancelled','archived');
COMMENT ON VIEW public.task_queue_health IS
  'Tasks needing attention. Severity is a function of CLASS as well as age (128, 130). '
  'pending_jeff_action rows promote IMMEDIATELY, bypassing jeff_action_days, when they are a '
  'kill-switch/security row (security_gate), are parked by the premise gate awaiting an '
  'exogenous accept/reject bit (premise_hold, 130), name a still-open task (blocks_open_gap), '
  'or carry a non-empty result (ack_only -- engineering done, only a human ack outstanding). '
  'Everything else keeps the age axis. The `decision` column is a per-row RECEIPT naming the '
  'property tested and the threshold applied for EVERY row, promoted or not.';

COMMIT;
