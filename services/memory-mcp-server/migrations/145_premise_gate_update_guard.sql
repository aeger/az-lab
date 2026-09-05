-- 145: the premise gate learns to hold on UPDATE — closing the one-statement bypass
-- ─────────────────────────────────────────────────────────────────────────────
-- DECISION OF RECORD. Jeff, 2026-08-29, on the filed finding "premise gate is
-- INSERT-only — any agent can UPDATE out of pending_jeff_action":
--   "ack_only rows should be exempt from the guard entirely"
-- That answers the one open question this migration was blocked on. The guard
-- itself was proposed in the same filing and is implemented here as proposed.
--
-- WHAT 130 ACTUALLY ENFORCED. Migration 130 constrains premise_audit.verdicts.
-- auditor to a non-runner ('jeff','heather','volt','iris') — wren/atlas/claude-
-- code are rejected by the DB, not by convention. That CHECK is real and was
-- verified. But the only enforcement trigger it shipped,
-- trg_ab_task_queue_premise_gate, is BEFORE **INSERT**. Nothing guarded UPDATE.
-- So the whole SEAL construction was reachable around in one statement:
--     UPDATE task_queue SET status='completed' WHERE id = <held row>;
-- The auditor CHECK is never consulted because no verdict row is ever written.
-- premise_gate_status() stays 'pending' forever, and the row leaves the ack
-- queue. SEAL condition 4 (conservative update: absent verdict == not deployed)
-- was implemented as a PARKING SPOT, not as a lock.
--
-- MEASURED, not theorised. Probe run 2026-08-29 over every gated row:
--   cf4272b9  completed  2026-08-25    54c7c9c1  completed  2026-08-25
--   cf66c977  archived   2026-08-28    54b36a3e  completed  2026-08-28
--   325e83d6  completed  2026-08-28    f465c0d7  completed  2026-08-28
-- Six of the seven rows the gate has ever held reached a terminal status with
-- premise_gate_status = 'pending' and zero verdicts. premise_audit.verdicts is
-- EMPTY. The oldest bypass is the day the gate went in. In practice migration
-- 130 has never once held anyone; it has been decorative since birth. f465c0d7
-- was restored to pending_jeff_action by guardian review on 2026-08-28 and was
-- flipped back to completed at 22:16:16Z the same evening — the bypass survived
-- being caught and written up, which is the strongest argument available that
-- convention was never going to close it.
--
-- WHY THIS IS THE VERIFIER-DEPLOYMENT GAP AGAIN, one level up. 130 quotes arXiv
-- 2607.24300: when an agent controls both the policy and the test that accepts
-- it, the two diverge. 130 moved the TEST out of the runner's reach (exogenous
-- auditor) but left the DEPLOYMENT GATE — the status column — inside it. The
-- agent could not grade itself, so it skipped grading and shipped anyway. Moving
-- the verdict exogenous is necessary and not sufficient; the release path has to
-- be constrained too, or the verdict is simply routed around.
--
-- THE GUARD. BEFORE UPDATE on task_queue. For a row that is premise-gated AND
-- has no verdict (premise_gate_status = 'pending'), three exits are closed:
--   1. status change out of pending_jeff_action
--   2. removal of the 'premise-hold' tag  (otherwise exit 1 is reachable in two
--      statements: detag to become ack_only, then flip)
--   3. stamping archived_at while the row is still parked (a soft exit that
--      would hide the row from every archived_at IS NULL reader)
-- Ungated rows — everything premise_gate_status() calls 'not_gated' — are
-- untouched, so poll_queue, sage, recover_stuck_tasks and the staleness sweep
-- see no behaviour change at all. Verified before writing: no automated writer
-- moves a pending_jeff_action row to a terminal status. sweep_stale_tasks is
-- notify-only by design and recover_stuck_tasks only touches claimed /
-- in_progress_agent, so this trigger cannot break a cron.
--
-- THE ESCAPE HATCH is the path the gate was designed around and is unchanged:
-- public.premise_decide(task, accept, auditor, note). It INSERTs the verdict
-- FIRST, so by the time it UPDATEs the row premise_gate_status() already reads
-- 'accept'/'reject' and this guard returns early. An auditor the CHECK rejects
-- cannot get a verdict in, and therefore cannot get a row out. That is the
-- whole point: the release path now runs THROUGH the auditor constraint instead
-- of beside it.
--
-- JEFF'S EXEMPTION (ack_only). ack_only is task_queue_health's class for
-- "engineering finished, only a human acknowledgement is outstanding" — the bulk
-- of the digest. Requiring a premise_audit row for each would be heavy, and Jeff
-- ruled them exempt outright. Encoded here exactly as the health view defines
-- the class: a non-empty result AND no 'premise-hold' tag (in the view's
-- precedence a premise-held row classes as premise_hold, never ack_only). The
-- exemption is read from OLD, never NEW, and closure #2 above locks the tag, so
-- an agent cannot manufacture its way into the exemption — not in one statement
-- (OLD still carries the tag) and not in two (the detag itself raises). The
-- exemption is therefore a promise about rows the gate never held, which is
-- precisely the population Jeff was protecting.
--
-- NOT DONE HERE, deliberately: the six historical bypasses are NOT reverted.
-- Reverting re-pages Jeff with six items whose work no one has re-reviewed, and
-- that is his call. They stay visible in the new premise_gate_bypasses view
-- below and can be adjudicated one at a time.
--
-- Apply via Supabase MCP apply_migration (records in schema_migrations, per 134)
-- or scripts/apply_sql.sh.

BEGIN;

-- ───────────────────────────────────────────────────────────── 1. the guard
CREATE OR REPLACE FUNCTION public.task_queue_premise_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  -- premise_gate_status() is SECURITY DEFINER and returns ONE of
  -- not_gated/pending/accept/reject (130, SEAL condition 3). Reading the gate
  -- through it rather than through premise_audit.claims directly keeps this
  -- trigger unprivileged and keeps the single-bit contract intact.
  v_gate     text := public.premise_gate_status(OLD.id);
  v_old_tags text[] := coalesce(OLD.tags, ARRAY[]::text[]);
  v_new_tags text[] := coalesce(NEW.tags, ARRAY[]::text[]);
  v_held     boolean := coalesce(OLD.tags, ARRAY[]::text[]) && ARRAY['premise-hold']::text[];
  -- Jeff 2026-08-29. Computed from OLD only. See header.
  v_ack_only boolean := coalesce(btrim(OLD.result), '') <> '' AND NOT v_held;
BEGIN
  IF v_gate <> 'pending' THEN
    RETURN NEW;          -- not_gated (the overwhelming majority), or already adjudicated
  END IF;

  IF v_ack_only THEN
    RETURN NEW;          -- exempt entirely, by decision
  END IF;

  IF OLD.status = 'pending_jeff_action' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'premise gate (130/145): task % is parked at pending_jeff_action with no exogenous premise verdict; refusing to move it to %',
      OLD.id, NEW.status
      USING HINT = 'Release it through public.premise_decide(''' || OLD.id ||
                   ''', <accept boolean>, ''jeff|heather|volt|iris'', ''<note>''). '
                   'wren/atlas/claude-code are not valid auditors — that is the gate, not a bug.',
            ERRCODE = 'P0001';
  END IF;

  IF v_held AND NOT (v_new_tags && ARRAY['premise-hold']::text[]) THEN
    RAISE EXCEPTION
      'premise gate (130/145): refusing to remove the premise-hold tag from task % while its premise verdict is still pending',
      OLD.id
      USING HINT = 'Detagging is premise_decide''s job and happens only after a verdict row exists. '
                   'Removing it by hand would reclass the row as ack_only and route it around the guard.',
            ERRCODE = 'P0001';
  END IF;

  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION
      'premise gate (130/145): refusing to archive task % while its premise verdict is still pending',
      OLD.id
      USING HINT = 'archived_at is a soft exit: every "archived_at IS NULL" reader would stop seeing the row '
                   'while its status still claimed it was parked for Jeff.',
            ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.task_queue_premise_update_guard() IS
  'SEAL condition 4, enforced instead of merely parked (145). 130 gated INSERT only, so a '
  'held row could be UPDATEd straight to completed and the auditor CHECK was never consulted — '
  'measured on 6 of the 7 rows the gate ever held. Blocks status change, premise-hold detag, and '
  'archived_at stamping while premise_gate_status() = pending. Ungated rows are untouched. '
  'ack_only rows (non-empty result, no premise-hold tag) are exempt entirely — Jeff, 2026-08-29.';

-- Name matters: BEFORE UPDATE triggers fire in name order. trg_ac_ puts this
-- AFTER trg_aa_task_queue_coerce_retired_status (so NEW.status is already the
-- coerced value we are judging) and BEFORE trg_task_queue_archive_on_terminal
-- (so the archived_at stamp cannot land ahead of the check that forbids it).
DROP TRIGGER IF EXISTS trg_ac_task_queue_premise_update_guard ON public.task_queue;
CREATE TRIGGER trg_ac_task_queue_premise_update_guard
  BEFORE UPDATE ON public.task_queue
  FOR EACH ROW EXECUTE FUNCTION public.task_queue_premise_update_guard();

-- ──────────────────────────────────── 2. give the bypass a standing reader
-- 118/121/128's recurring lesson is that an unread signal rots. The bypass was
-- found by a hand-run probe; without a view it would have to be remembered.
-- This one is empty in a healthy system and lists exactly the rows that left the
-- gate without a verdict — the six historical ones today, and any that a future
-- direct-SQL path (a superuser, a trigger-disabling migration) sneaks past.
CREATE OR REPLACE VIEW public.premise_gate_bypasses AS
SELECT t.id,
       t.title,
       t.status,
       t.archived_at,
       t.updated_at,
       c.gated_at,
       coalesce(btrim(t.result), '') <> '' AS result_present,
       format('FINDING premise_gate_bypass — row is premise-gated and reached %L with '
              'premise_gate_status=pending and 0 rows in premise_audit.verdicts; '
              'gated %s, left the gate %s. Pre-145 rows are historical; a post-145 row here '
              'means the guard was bypassed at a level the trigger cannot see.',
              t.status, c.gated_at::date, t.updated_at::date) AS decision
  FROM public.task_queue t
  JOIN premise_audit.claims c ON c.task_id = t.id
 WHERE t.status <> 'pending_jeff_action'
   AND public.premise_gate_status(t.id) = 'pending'
 ORDER BY c.gated_at;

GRANT SELECT ON public.premise_gate_bypasses TO service_role;

COMMENT ON VIEW public.premise_gate_bypasses IS
  'Gated rows that reached a non-parked status with no exogenous verdict. Empty in a healthy '
  'system. Holds 6 historical rows (2026-08-25 .. 2026-08-28) that predate the 145 UPDATE guard; '
  'they are deliberately NOT reverted — re-paging Jeff with six unreviewed items is his call.';

COMMIT;
