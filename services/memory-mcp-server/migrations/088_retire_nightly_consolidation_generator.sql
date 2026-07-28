-- 088_retire_nightly_consolidation_generator.sql
--
-- Retire the nightly "Run nightly episodic memory consolidation" /
-- "Send nightly consolidation notification to Discord" task pair.
--
-- WHY
--   The pair is emitted daily (~03:01 UTC) from a cowork-side schedule with
--   source='cowork', target='claude-code', as plain INSERTs. Both have been
--   no-ops since 2026-07-21 and every fire costs a Wren session a manual
--   triage + close:
--
--   * The script the task points at, ~/azlab/memory-mcp-server/
--     consolidate_episodic_memories.py, does not exist at that path and never
--     has. The real file is ~/azlab/infrastructure/memory-consolidation/
--     consolidate_episodic_memories.py.
--   * That real file was formally deprecated 2026-07-21. It is a hard no-op
--     unless --force-legacy is passed. Its docstring says outright
--     "Do NOT run this and do NOT re-diagnose it."
--   * Original defect: it gated the episodic fetch on access_count >= 3, but
--     episodic retrieval never increments access_count. So it always logged
--     "No eligible episodic memories found" and exited 0 — success-shaped, but
--     doing nothing. Confirmed in consolidate.log for every run
--     2026-06-24 .. 2026-07-21.
--   * It was never installed to a systemd timer. It only ever ran when an
--     agent manually invoked it from this cowork queue task.
--
--   The Discord twin is redundant too: the live pipeline already posts its own
--   completion to the agent bus (POST localhost:8765/message).
--
-- WHAT ACTUALLY DOES THE WORK NOW (healthy, untouched by this migration)
--   ~/azlab/services/memory-mcp-server/episodic_distill.py, Phase 0, installed
--   as episodic-distill.timer -> episodic-distill.service, daily 03:00 UTC.
--   Phase 0 clusters on embedding cosine similarity with NO access_count
--   prefilter — the correct "recurred across sessions" signal.
--
-- WHY A DB-SIDE GUARD RATHER THAN DISABLING THE EMITTER
--   The emitter is not reachable from svc-podman-01. It is not a systemd
--   timer, not a user crontab, not pg_cron, not `upsert_recurring_task`, and
--   not one of the 6 claude.ai CCR routines (enumerated via RemoteTrigger on
--   2026-07-28 — zero matches for "consolidat"). It is a cowork-side schedule
--   on a surface Claude Code cannot enumerate or edit. Same unresolved class
--   as the breakthrough-watch emitter noted in iris_trigger_prompt_diff.md.
--   Guarding at the task_queue boundary retires the pair regardless of which
--   cloud surface emits it.
--
-- BEHAVIOUR
--   Matching rows are auto-retired at INSERT time: status='completed',
--   archived_at=now(), with a note in result and a context stamp. They never
--   reach 'ready'/'pending'/'delegated', so poll_queue.py never claims them
--   and no Wren session triages them.
--
--   Deliberately NOT a silent DROP (RETURN NULL): keeping the row preserves
--   evidence that the upstream emitter is still firing. To check whether it
--   has stopped:
--     SELECT count(*), max(created_at) FROM task_queue
--     WHERE context->'auto_retired'->>'rule' = 'nightly_consolidation_retired';
--   Once that stops advancing, the cowork-side schedule is genuinely gone and
--   this trigger can be dropped.
--
-- SCOPE / SAFETY
--   Gated on source='cowork' AND exact legacy titles, or a cowork-sourced row
--   pointing at the deprecated script path. Meta-work about this retirement
--   (e.g. the "Retire the nightly ... generator" task itself, source
--   'claude-code') does not match. The replacement health check does not match
--   either — it carries neither legacy title nor the deprecated path.

BEGIN;

-- ── predicate ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.task_is_retired_nightly_consolidation(
  p_title       text,
  p_description text,
  p_source      text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(p_source, '') = 'cowork'
     AND (
           btrim(COALESCE(p_title, '')) IN (
             'Run nightly episodic memory consolidation',
             'Send nightly consolidation notification to Discord'
           )
           -- backstop: any cowork task still pointing at the deprecated script
           OR COALESCE(p_description, '') ILIKE '%consolidate_episodic_memories.py%'
         );
$$;

-- ── BEFORE INSERT trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.retire_nightly_consolidation_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.task_is_retired_nightly_consolidation(
       NEW.title, NEW.description, NEW.source)
  THEN
    NEW.status      := 'completed';
    NEW.archived_at := now();
    NEW.claimed_by  := 'migration_088';
    NEW.claimed_at  := now();
    NEW.result      := 'Auto-retired: redundant since 2026-07-21. The live '
                    || 'pipeline is episodic_distill.py Phase 0 via '
                    || 'episodic-distill.timer (daily 03:00 UTC), which also '
                    || 'posts its own agent-bus completion. The script this '
                    || 'task names is deprecated and a hard no-op. No action '
                    || 'needed — do not re-diagnose. See migration 088.';

    NEW.context := COALESCE(NEW.context, '{}'::jsonb)
      || jsonb_build_object(
           'auto_retired', jsonb_build_object(
             'rule',        'nightly_consolidation_retired',
             'reason',      'redundant_since_2026_07_21',
             'superseded_by', 'episodic-distill.timer / episodic_distill.py Phase 0',
             'migration',   '088',
             'at',          to_jsonb(now())
           )
         );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_retire_nightly_consolidation
  ON public.task_queue;

-- Ordered to run after the infra-remediation routing backstop (migration 042);
-- BEFORE INSERT row triggers fire in name order, and 'trg_e...' < 'trg_r...'.
CREATE TRIGGER trg_retire_nightly_consolidation
  BEFORE INSERT ON public.task_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.retire_nightly_consolidation_task();

REVOKE EXECUTE ON FUNCTION
  public.task_is_retired_nightly_consolidation(text, text, text)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  public.retire_nightly_consolidation_task()
  FROM anon, authenticated;

COMMIT;

-- Verification:
--   -- should return a row with status=completed and archived_at set:
--   INSERT INTO task_queue (title, description, source, target, status)
--   VALUES ('Run nightly episodic memory consolidation', 'x', 'cowork',
--           'claude-code', 'ready')
--   RETURNING id, status, archived_at, context->'auto_retired';
--
--   -- should be UNAFFECTED (status stays 'ready'):
--   INSERT INTO task_queue (title, description, source, target, status)
--   VALUES ('Check episodic-distill pipeline health', 'y', 'claude-code',
--           'wren', 'ready')
--   RETURNING id, status;
