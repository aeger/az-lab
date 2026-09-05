-- 145b: premise_ack() — the release path for a gated row whose work is ALREADY DONE
-- ─────────────────────────────────────────────────────────────────────────────
-- Found while testing 145, not theorised: with the UPDATE guard in place, the six
-- rows the gate leaked (and f465c0d7 in particular) had NO usable acknowledgement
-- path left. Their engineering is finished and verified; the only outstanding item
-- is Jeff's ack. But:
--   * flipping them to 'completed' is exactly what the 145 guard now blocks, and
--   * premise_decide(accept) sets status='ready' — which hands an already-finished
--     task back to poll_queue, and it would be re-claimed and re-run inside 5 min.
-- Neither is the operation the human actually wants. So a guard with no ack path is
-- a guard that will be worked around within a week — which is the exact history 130
-- already has. This adds the missing verb rather than weakening the guard.
--
-- premise_ack IS still an exogenous verdict: it writes a real row to
-- premise_audit.verdicts, so the auditor CHECK from 130 applies unchanged
-- (wren/atlas/claude-code are rejected by the DB). It differs from premise_decide
-- only in where the row lands: completed, not ready, because the work exists.
-- It REFUSES a row with an empty result — an empty result means the work was not
-- done, and 'completed' would then be a lie; that case belongs to premise_decide.
--
-- Verdict is INSERTed before the UPDATE, so by the time the row moves,
-- premise_gate_status() already reads 'accept' and the 145 guard returns early.
-- One transaction: the row never passes through 'ready', so poll_queue never sees it.

BEGIN;

CREATE OR REPLACE FUNCTION public.premise_ack(
  p_task    uuid,
  p_auditor text,
  p_note    text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, premise_audit, pg_temp
AS $$
DECLARE
  v_tags   text[];
  v_result text;
  v_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM premise_audit.claims WHERE task_id = p_task) THEN
    RAISE EXCEPTION 'premise_ack: task % is not premise-gated (nothing to ack here — just update it)', p_task;
  END IF;

  SELECT coalesce(tags, ARRAY[]::text[]), coalesce(btrim(result), ''), status
    INTO v_tags, v_result, v_status
    FROM public.task_queue WHERE id = p_task;

  IF v_result = '' THEN
    RAISE EXCEPTION 'premise_ack: task % has an empty result — there is no finished work to acknowledge', p_task
      USING HINT = 'Use premise_decide(task, accept, auditor, note) instead: accept sends it to ready to be built, '
                   'reject cancels it.';
  END IF;

  INSERT INTO premise_audit.verdicts (task_id, verdict, auditor, note)
  VALUES (p_task, true, lower(btrim(p_auditor)), p_note)
  ON CONFLICT (task_id) DO UPDATE
    SET verdict = true, auditor = EXCLUDED.auditor, note = EXCLUDED.note, decided_at = now();

  v_tags := array_remove(v_tags, 'premise-hold');
  UPDATE public.task_queue
     SET status = 'completed',
         tags   = array_append(v_tags, 'premise-accepted')
   WHERE id = p_task;

  RETURN 'acked';
END $$;

COMMENT ON FUNCTION public.premise_ack(uuid, text, text) IS
  'Acknowledge a premise-gated row whose engineering is already finished: records a real exogenous '
  'accept verdict (130 auditor CHECK applies) and marks the row completed in the same transaction, so '
  'it never passes through ready and poll_queue never re-claims it. Refuses rows with an empty result — '
  'those have no work to acknowledge and belong to premise_decide(). Added with the 145 UPDATE guard, '
  'which otherwise leaves finished-but-unacked gated rows with no legal exit.';

COMMIT;
