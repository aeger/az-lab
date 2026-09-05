-- 092_mutation_time_forgetting_hook.sql
-- 2026-07-31 daily research, REC 1.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- "Control-Plane Placement Shapes Forgetting" (arXiv 2606.15903) measures where
-- the LLM sits relative to the CONTROL plane (supersede / release / purge) rather
-- than the recall plane. Three regimes:
--
--   deterministic primitives  5% identifier obfuscation, 0% cross-lingual, 64-191ms
--   inscribe-time LLM         100% canonicalization, 0% intent-aware deletion
--   mutation-time hook        78-85% intent-aware deletion, 91.7-93.2% overall, 2.3s
--
-- az-lab's control plane is 100% deterministic SQL predicates: 073 supersession
-- heuristic, 085 staleness-from-verified_at, 065 retire_cold_memories. That is
-- exactly the first row.
--
-- Verified before building (2026-07-31):
--   * log_memory_change() -- the ONLY existing trigger on memories that writes an
--     audit row -- logs INSERT, DELETE, and UPDATE-where-content-changed. It does
--     NOT fire on is_active, superseded_by or retired_at transitions, because
--     those change no content. So the entire forgetting control plane is, today,
--     completely unaudited. There is no record of which of the 117 rows that
--     acquired retired_at in the last 24h were retired correctly.
--   * 162 rows is_active = false, 117 retired_at set, 0 conflict_flagged.
--
-- ============================================================================
-- WHAT THIS DOES, AND THE ONE PLACE IT DEPARTS FROM THE PAPER
-- ============================================================================
-- The recommendation says "wrap forget/supersede/retirement-execute in a
-- Nemotron 120B check". You cannot do that literally inside Postgres:
-- plpgsql has no synchronous HTTP, pg_net is fire-and-forget, and blocking a
-- write on a 2.3 s external LLM call makes every retirement sweep a liveness
-- risk. So the hook is SPLIT, and each half is placed where it can actually hold:
--
--   SYNCHRONOUS + IN-DB + BYPASS-PROOF (this migration)
--     (a) a BEFORE trigger deterministic guard that refuses the small set of
--         mutations that are structurally wrong -- retiring a row that an ACTIVE
--         eval probe uses as a positive gold, or a lifecycle_pinned row.
--     (b) an AFTER trigger that captures EVERY control-plane transition into
--         memory_forget_audit with a content snapshot, so a revert is always
--         possible and the adjudicator has something to read.
--
--   ASYNCHRONOUS + LLM (forget_review_worker.py, this commit)
--     (c) Nemotron 120B drains forgetting_review_queue and calls
--         review_forget_mutation(); a 'wrong' verdict reverts the row.
--
-- The trigger placement is the load-bearing decision, and it is deliberate.
-- REC 1 called it out and it is the same failure as the 085 staleness defect:
-- agents stamping verified_at through execute_sql bypassed the MCP tool layer
-- entirely and the backlog sat at 381 -> 396 -> 392 while the tool-layer logic
-- was correct the whole time. A hook that lives only in the `forget` handler in
-- src/index.ts is bypassed by Wren, Iris, Atlas, retire_cold_memories(),
-- discard_redundant_memories(), and every psql session -- which is nearly all of
-- the real traffic. A trigger cannot be bypassed by any of them.
--
-- 2.3 s lands on the WRITE path only, and here not even there: the write returns
-- as soon as the audit row is inserted. Nothing in this migration touches
-- hybrid_recall. Recall latency is unchanged, deliberately.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Settings. Every part of this is independently switchable, because a guard
--    that cannot be turned off during an incident is itself an incident.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.forget_guard_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  audit_enabled        boolean NOT NULL DEFAULT true,
  guard_enabled        boolean NOT NULL DEFAULT true,
  -- 'veto'  = skip the offending ROW, let the rest of the statement commit
  -- 'block' = RAISE, aborting the whole statement
  -- Default 'veto' on purpose: retire_cold_memories() and
  -- discard_redundant_memories() update in bulk, and a raise on row 40 of 117
  -- rolls back the other 116. A guard that turns a bad row into a failed nightly
  -- sweep would get switched off within a week, which is worse than no guard.
  guard_mode           text NOT NULL DEFAULT 'veto'
                       CHECK (guard_mode = ANY (ARRAY['veto','block'])),
  llm_review_enabled   boolean NOT NULL DEFAULT true,
  auto_revert_enabled  boolean NOT NULL DEFAULT false,
  revert_min_confidence double precision NOT NULL DEFAULT 0.80,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  notes                text
);

INSERT INTO public.forget_guard_settings (id, notes)
VALUES (true, 'created by migration 092')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.forget_guard_settings IS
  'Kill switches for the mutation-time forgetting hook (migration 092). '
  'auto_revert_enabled starts FALSE: the LLM adjudicator runs in observe-only '
  'mode until its verdicts have been eyeballed against a few dozen real '
  'mutations. Flip it only after reviewing memory_forget_audit.';

-- ---------------------------------------------------------------------------
-- 2. The audit table. One row per control-plane transition, whatever wrote it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_forget_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id         uuid,                    -- deliberately NOT a FK: survives hard DELETE
  memory_name       text,
  memory_type       text,
  op                text NOT NULL CHECK (op = ANY (ARRAY[
                      'deactivate','reactivate','supersede','retire','unretire','delete'])),

  old_is_active     boolean,
  new_is_active     boolean,
  old_superseded_by uuid,
  new_superseded_by uuid,
  old_retired_at    timestamptz,
  new_retired_at    timestamptz,
  retire_reason     text,

  -- Snapshot so a revert never depends on the row still being readable, and so
  -- the adjudicator can judge intent from what was actually removed.
  content_snapshot  text,
  description_snapshot text,

  -- Who. current_user is the Postgres role; application_name is what
  -- distinguishes the MCP server from a psql session from a python job.
  db_user           text NOT NULL DEFAULT current_user,
  app_name          text,
  writer_agent      text,

  review_status     text NOT NULL DEFAULT 'pending'
                    CHECK (review_status = ANY (ARRAY[
                      'pending','approved','wrong','uncertain','reverted','skipped','vetoed'])),
  -- Set when the deterministic guard refused the mutation. The row is a record
  -- of a forgetting attempt that did NOT happen.
  veto_reason       text,
  review_verdict    jsonb,
  review_reasoning  text,
  review_confidence double precision,
  reviewed_by       text,
  reviewed_at       timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forget_audit_pending
  ON public.memory_forget_audit (created_at)
  WHERE review_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_forget_audit_memory
  ON public.memory_forget_audit (memory_id);

COMMENT ON TABLE public.memory_forget_audit IS
  'Every is_active / superseded_by / retired_at transition on memories, captured '
  'by trigger (migration 092) so direct-SQL writers cannot bypass it. memory_id '
  'is intentionally not a foreign key so the row survives a hard DELETE of its '
  'subject -- which is the case where the audit matters most.';

-- ---------------------------------------------------------------------------
-- 3. Deterministic guard (BEFORE). Small, certain, and synchronous.
--
--    Scope is deliberately narrow. This is NOT where intent-aware deletion
--    happens -- 2606.15903's whole point is that deterministic predicates score
--    5% at that. It only refuses mutations that are wrong on structural grounds
--    a predicate CAN decide, which is why it is safe to run in-line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_memory_forgetting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_enabled boolean;
  v_mode    text;
  v_going_dark boolean;
  v_reason  text := NULL;
BEGIN
  SELECT s.guard_enabled, s.guard_mode
    INTO v_enabled, v_mode
  FROM public.forget_guard_settings s WHERE s.id;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- "Going dark" = the row stops being retrievable by hybrid_recall, which
  -- filters is_active on all six lanes.
  v_going_dark := (COALESCE(OLD.is_active, true) IS TRUE AND NEW.is_active IS FALSE)
               OR (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL);

  IF NOT v_going_dark THEN
    RETURN NEW;
  END IF;

  -- (i) Never silently retire a row an ACTIVE eval probe scores as a positive
  --     gold. Doing so does not fail loudly -- it just lowers recall@5 on the
  --     next nightly and looks like a ranker regression. That misattribution is
  --     expensive; this is one predicate that prevents it.
  IF EXISTS (
    SELECT 1 FROM public.eval_queries q
    WHERE q.active AND NEW.id = ANY(q.gold_memory_ids)
  ) THEN
    v_reason := 'positive gold in an active eval probe; retiring it would depress '
                'recall@5 on the next nightly and read as a ranker regression';

  -- (ii) lifecycle_pinned already means "the lifecycle sweep must not touch
  --      this". Enforce it at the row rather than trusting each sweep's WHERE.
  ELSIF COALESCE(NEW.lifecycle_pinned, false) AND COALESCE(OLD.lifecycle_pinned, false) THEN
    v_reason := 'lifecycle_pinned';
  END IF;

  IF v_reason IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_mode, 'veto') = 'block' THEN
    RAISE EXCEPTION 'forget-guard: memory % (%) — %. Unset the condition, or set '
      'forget_guard_settings.guard_enabled = false to override.',
      NEW.id, NEW.name, v_reason
      USING ERRCODE = 'raise_exception';
  END IF;

  -- veto mode: log the refused attempt, then skip THIS row only by returning
  -- NULL. The rest of the statement commits. Logging here is mandatory --
  -- a skipped row fires no AFTER trigger, so this is the only chance to record
  -- that a forgetting attempt was made and refused.
  INSERT INTO public.memory_forget_audit (
    memory_id, memory_name, memory_type, op,
    old_is_active, new_is_active, old_retired_at, new_retired_at,
    retire_reason, content_snapshot, description_snapshot,
    app_name, writer_agent, review_status, veto_reason
  ) VALUES (
    OLD.id, OLD.name, OLD.type,
    CASE WHEN NEW.is_active IS FALSE THEN 'deactivate' ELSE 'retire' END,
    OLD.is_active, NEW.is_active, OLD.retired_at, NEW.retired_at,
    NEW.retire_reason, OLD.content, OLD.description,
    current_setting('application_name', true),
    COALESCE(NEW.writer_agent, OLD.writer_agent),
    'vetoed', v_reason
  );

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.guard_memory_forgetting IS
  'BEFORE-UPDATE guard (migration 092): refuses the two structurally-wrong '
  'forgetting mutations a deterministic predicate can actually decide -- '
  'retiring an active eval gold, and retiring a lifecycle_pinned row. '
  'Intent-aware deletion is NOT decided here; that is the async LLM half.';

DROP TRIGGER IF EXISTS memories_forget_guard ON public.memories;
CREATE TRIGGER memories_forget_guard
  BEFORE UPDATE ON public.memories
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active
     OR OLD.retired_at IS DISTINCT FROM NEW.retired_at)
  EXECUTE FUNCTION public.guard_memory_forgetting();

-- ---------------------------------------------------------------------------
-- 4. Audit capture (AFTER). Fires for UPDATE and DELETE alike.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_memory_forgetting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_enabled boolean;
  v_op      text;
  v_app     text;
BEGIN
  SELECT s.audit_enabled INTO v_enabled FROM public.forget_guard_settings s WHERE s.id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_app := current_setting('application_name', true);
  EXCEPTION WHEN OTHERS THEN
    v_app := NULL;
  END;

  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
  ELSIF COALESCE(OLD.is_active, true) IS TRUE AND NEW.is_active IS FALSE THEN
    v_op := 'deactivate';
  ELSIF OLD.is_active IS FALSE AND COALESCE(NEW.is_active, true) IS TRUE THEN
    v_op := 'reactivate';
  ELSIF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    v_op := 'retire';
  ELSIF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN
    v_op := 'unretire';
  ELSIF OLD.superseded_by IS DISTINCT FROM NEW.superseded_by
        AND NEW.superseded_by IS NOT NULL THEN
    v_op := 'supersede';
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO public.memory_forget_audit (
    memory_id, memory_name, memory_type, op,
    old_is_active, new_is_active,
    old_superseded_by, new_superseded_by,
    old_retired_at, new_retired_at, retire_reason,
    content_snapshot, description_snapshot,
    app_name, writer_agent,
    -- Reactivate/unretire are the SAFE direction. Auditing them keeps the trail
    -- complete, but queueing them for LLM review would just burn tokens.
    review_status
  ) VALUES (
    COALESCE(NEW.id, OLD.id), COALESCE(NEW.name, OLD.name), COALESCE(NEW.type, OLD.type), v_op,
    OLD.is_active, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.is_active END,
    OLD.superseded_by, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.superseded_by END,
    OLD.retired_at, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.retired_at END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.retire_reason ELSE NEW.retire_reason END,
    OLD.content, OLD.description,
    v_app, COALESCE(NEW.writer_agent, OLD.writer_agent),
    CASE WHEN v_op IN ('reactivate','unretire') THEN 'skipped' ELSE 'pending' END
  );

  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.audit_memory_forgetting IS
  'AFTER trigger (migration 092): records every control-plane transition on '
  'memories into memory_forget_audit, with a pre-image content snapshot so a '
  'revert never depends on the row still being readable. Placed at the table, '
  'not in the MCP tool layer, because retire_cold_memories(), '
  'discard_redundant_memories() and every execute_sql caller bypass the tool '
  'layer -- the exact bypass that let the 085 staleness backlog sit unmoved.';

DROP TRIGGER IF EXISTS memories_forget_audit ON public.memories;
CREATE TRIGGER memories_forget_audit
  AFTER UPDATE OR DELETE ON public.memories
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_memory_forgetting();

-- ---------------------------------------------------------------------------
-- 5. The queue the async adjudicator drains.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.forgetting_review_queue AS
SELECT
  a.id            AS audit_id,
  a.memory_id,
  a.memory_name,
  a.memory_type,
  a.op,
  a.retire_reason,
  a.db_user,
  a.app_name,
  a.writer_agent,
  a.created_at,
  a.description_snapshot,
  left(a.content_snapshot, 4000) AS content_excerpt,
  m.is_active     AS current_is_active,
  m.retired_at    AS current_retired_at,
  (m.id IS NULL)  AS hard_deleted,
  -- Context that makes an intent judgement possible rather than a coin flip.
  (SELECT count(*) FROM public.memory_links l
    WHERE l.source_id = a.memory_id OR l.target_id = a.memory_id) AS link_count,
  (SELECT s.name FROM public.memories s WHERE s.id = a.new_superseded_by) AS superseded_by_name
FROM public.memory_forget_audit a
LEFT JOIN public.memories m ON m.id = a.memory_id
WHERE a.review_status = 'pending'
ORDER BY a.created_at;

COMMENT ON VIEW public.forgetting_review_queue IS
  'Pending control-plane mutations awaiting LLM adjudication (migration 092). '
  'Drained by forget_review_worker.py against Nemotron 120B.';

-- ---------------------------------------------------------------------------
-- 6. Verdict sink. The adjudicator writes here; revert happens here too, so the
--    revert path is one auditable operator rather than ad-hoc UPDATEs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_forget_mutation(
  p_audit_id   uuid,
  p_verdict    text,
  p_reasoning  text DEFAULT NULL,
  p_confidence double precision DEFAULT NULL,
  p_reviewer   text DEFAULT 'nemotron-120b',
  p_failure_mode text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a          public.memory_forget_audit%ROWTYPE;
  v_auto     boolean;
  v_minconf  double precision;
  v_reverted boolean := false;
BEGIN
  IF p_verdict NOT IN ('approved','wrong','uncertain') THEN
    RAISE EXCEPTION 'review_forget_mutation: verdict must be approved|wrong|uncertain, got %', p_verdict;
  END IF;

  SELECT * INTO a FROM public.memory_forget_audit WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'review_forget_mutation: no audit row %', p_audit_id;
  END IF;

  SELECT s.auto_revert_enabled, s.revert_min_confidence
    INTO v_auto, v_minconf
  FROM public.forget_guard_settings s WHERE s.id;

  IF p_verdict = 'wrong'
     AND COALESCE(v_auto, false)
     AND COALESCE(p_confidence, 0) >= COALESCE(v_minconf, 0.80)
     AND a.op IN ('deactivate','retire','supersede')
     AND EXISTS (SELECT 1 FROM public.memories m WHERE m.id = a.memory_id)
  THEN
    -- Restore only the fields this mutation changed. Deliberately does not
    -- touch content: this reverses a forgetting decision, not an edit.
    UPDATE public.memories m SET
      is_active     = COALESCE(a.old_is_active, true),
      retired_at    = a.old_retired_at,
      retire_reason = NULL,
      superseded_by = a.old_superseded_by
    WHERE m.id = a.memory_id;
    v_reverted := true;
  END IF;

  UPDATE public.memory_forget_audit SET
    review_status     = CASE WHEN v_reverted THEN 'reverted' ELSE p_verdict END,
    review_reasoning  = p_reasoning,
    review_confidence = p_confidence,
    reviewed_by       = p_reviewer,
    reviewed_at       = now(),
    review_verdict    = jsonb_build_object(
                          'verdict', p_verdict,
                          'failure_mode', p_failure_mode,
                          'auto_reverted', v_reverted)
  WHERE id = p_audit_id;

  RETURN jsonb_build_object(
    'audit_id', p_audit_id,
    'verdict', p_verdict,
    'reverted', v_reverted,
    'memory_id', a.memory_id);
END;
$function$;

COMMENT ON FUNCTION public.review_forget_mutation IS
  'Records an adjudication verdict on a captured forgetting mutation and, when '
  'auto_revert_enabled and confidence clears revert_min_confidence, restores the '
  'row (migration 092). Reverts is_active/retired_at/superseded_by only -- never '
  'content, because this reverses a forgetting decision, not an edit.';

-- ---------------------------------------------------------------------------
-- 7. Observability: is the hook actually adjudicating, or silently idle?
--    This is the counter that would have caught the dead-lane pattern early.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.forgetting_hook_health AS
SELECT
  count(*)                                                        AS captured_total,
  count(*) FILTER (WHERE review_status = 'pending')               AS pending,
  count(*) FILTER (WHERE review_status = 'approved')              AS approved,
  count(*) FILTER (WHERE review_status IN ('wrong','reverted'))   AS judged_wrong,
  count(*) FILTER (WHERE review_status = 'reverted')              AS auto_reverted,
  count(*) FILTER (WHERE review_status = 'uncertain')             AS uncertain,
  count(*) FILTER (WHERE review_status = 'vetoed')                AS vetoed_by_guard,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS captured_24h,
  max(created_at)                                                 AS last_capture,
  max(reviewed_at)                                                AS last_review
FROM public.memory_forget_audit;

COMMENT ON VIEW public.forgetting_hook_health IS
  'One-row health summary of the mutation-time forgetting hook (migration 092). '
  'pending climbing while last_review stays old means the worker is dead -- the '
  'same dead-lane failure as the pre-085 staleness sweep.';

COMMIT;
