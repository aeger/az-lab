-- ---------------------------------------------------------------------------
-- 149: revoke anon EXECUTE on SECURITY DEFINER writers in schema public
-- ---------------------------------------------------------------------------
-- Audit 2026-09-05 (follow-up to migration 125 and to the memory
-- [[supabase-revoke-from-public-does-not-revoke-anon]]).
--
-- 50 of 94 SECURITY DEFINER functions in schema public were EXECUTE-able by
-- `anon` — the role behind the publishable key, which is public by design and
-- unauthenticated. SECURITY DEFINER means these run as their owner and bypass
-- RLS, so every one of them that writes was an unauthenticated, RLS-bypassing
-- write path into memories / task_queue / scheduled_activity / premise_audit.
--
-- Two distinct grant sources, and fixing only one is the classic mistake:
--   1. `=X/postgres`  — the implicit PUBLIC grant Postgres puts on every new
--                       function. Removed by REVOKE ... FROM PUBLIC.
--   2. `anon=X/...`   — an EXPLICIT grant, because Supabase ships
--                       ALTER DEFAULT PRIVILEGES granting EXECUTE on new public
--                       functions to anon and authenticated. REVOKE FROM PUBLIC
--                       does NOT touch it. anon must be revoked BY NAME.
-- 10 of the 36 below carried only (1); the other 26 carried both.
--
-- Classification of the 50 anon-reachable SECURITY DEFINER functions:
--   * 33 writers  — locked down here.
--   *  3 trigger functions (conflict_intake_gate, extract_facts_from_content,
--        memories_extract_entities_trigger) — not RPC-callable (they return
--        `trigger`), but they held anon grants for no reason. Locked down for
--        hygiene. Trigger firing does not re-check EXECUTE, so the triggers
--        keep working; the verify block below proves it.
--   * 14 read-only — NOT touched by this migration. Six are migration
--        assertion helpers (apply_*_if_missing); the rest are readers
--        (check_stale_context, extract_entities, lab_health_snapshot,
--        memory_health_snapshot, premise_gate_status, premise_pending,
--        spreading_activation_rerank, unverified_high_recall_memories).
--        Several of those DO disclose memory content to anon and are an
--        open information-disclosure surface — tracked separately, since
--        closing a read path is a different call than closing a write path.
--
-- Caller blast radius was checked before writing this: every `/rest/v1/rpc/`
-- caller in azlab/, dashboard/ and claude/ authenticates with
-- SUPABASE_SECRET_KEY (service_role). The publishable key is used only for
-- realtime WebSockets and plain table reads, never for RPC. No known caller
-- loses access.
--
-- Template: migration 125 (record_daily_research), already correct.
-- ---------------------------------------------------------------------------

BEGIN;

-- The 36 signatures are declared once and drive both the grant changes and the
-- verification below, so the two can never drift apart.
DO $lock$
DECLARE
  v_sig     text;
  v_sigs    text[] := ARRAY[
    'public.assign_memory_tiers()'
    ,'public.attach_episode_consults(text,uuid[],interval,uuid,uuid[])'
    ,'public.backfill_skill_outcomes_from_episodes(integer,boolean)'
    ,'public.bump_skill_usage(uuid[])'
    ,'public.clear_orphan_conflict_flags()'
    ,'public.conflict_block_report(integer)'
    ,'public.conflict_intake_gate()'
    ,'public.consolidate_similar_memories(double precision,boolean,double precision)'
    ,'public.detect_temporal_supersession(integer)'
    ,'public.eval_access_snapshot_restore()'
    ,'public.eval_access_snapshot_take()'
    ,'public.extract_facts_from_content()'
    ,'public.hybrid_recall(text,text,double precision,integer,text,text,text,double precision,text,text,text[],timestamp with time zone)'
    ,'public.hybrid_recall_v2(text,text,double precision,integer,text,text,text,double precision,text,text,text[],timestamp with time zone)'
    ,'public.mark_consistency_checked()'
    ,'public.memories_extract_entities_trigger()'
    ,'public.premise_ack(uuid,text,text)'
    ,'public.premise_decide(uuid,boolean,text,text)'
    ,'public.reap_stale_episodes(interval,boolean)'
    ,'public.record_recurring_run_result(uuid,text,text,text)'
    ,'public.record_scheduled_run(text,text,text,timestamp with time zone,numeric,text)'
    ,'public.refresh_lexeme_doc_freq()'
    ,'public.refresh_memory_duplicate_pairs()'
    ,'public.refresh_memory_outcome_utility()'
    ,'public.resolve_conflict_auto(uuid,text)'
    ,'public.retire_cold_memories(integer,boolean)'
    ,'public.review_forget_mutation(uuid,text,text,double precision,text,text)'
    ,'public.supersede_memory(uuid,uuid,text,text)'
    ,'public.sweep_conflicts(integer,text,text[])'
    ,'public.task_queue_premise_claim()'
    ,'public.unretire_memory(uuid)'
    ,'public.unsupersede_memory(uuid,text,text)'
    ,'public.update_memory_verified(uuid)'
    ,'public.update_read_watermark(text)'
    ,'public.upsert_recurring_task(text,text,text,jsonb,integer,text,text,text[])'
    ,'public.upsert_scheduled_activity(text,text,text,jsonb,text,text,text[],boolean)'
  ];
  v_bad     text[] := '{}';
  v_missing text[] := '{}';
  v_ent     text[];
  v_leaked  int;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    -- REVOKE FROM PUBLIC drops the implicit `=X/postgres` grant; REVOKE FROM
    -- anon drops the explicit grant Supabase default privileges added at
    -- CREATE time. Both are required — neither alone is sufficient.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, authenticated', v_sig);
  END LOOP;

  -- -------------------------------------------------------------------------
  -- Verify
  -- -------------------------------------------------------------------------
  FOREACH v_sig IN ARRAY v_sigs LOOP
    -- The whole point of the migration: anon must not hold EXECUTE.
    -- has_function_privilege resolves through both the PUBLIC grant and the
    -- named anon grant, so this catches either one surviving.
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      v_bad := v_bad || v_sig;
    END IF;
    -- ...and the legitimate caller must not have been locked out.
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      v_missing := v_missing || v_sig;
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 149: anon still holds EXECUTE on % function(s): %',
      array_length(v_bad, 1), array_to_string(v_bad, ', ');
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 149: service_role LOST EXECUTE on % function(s): %',
      array_length(v_missing, 1), array_to_string(v_missing, ', ');
  END IF;

  -- Revoking EXECUTE on a trigger function must not stop the trigger firing
  -- (Postgres checks EXECUTE at CREATE TRIGGER time, not at fire time).
  -- Prove that against the real table rather than asserting it from memory.
  -- The probe row is rolled back via the inner block's implicit savepoint
  -- rather than DELETEd: deleting a memory can trip the known memory_log FK
  -- constraint, and a cleanup failure must not abort the migration.
  -- PL/pgSQL variables survive the rollback, so v_ent is still readable.
  BEGIN
    INSERT INTO public.memories (name, type, content, description, source)
    VALUES ('mig149_trigger_probe', 'reference',
            'probe mentioning traefik and supabase', 'migration 149 probe', 'migration-149')
    RETURNING entities INTO v_ent;
    RAISE EXCEPTION 'mig149-probe-rollback';
  EXCEPTION WHEN OTHERS THEN
    -- Anything other than our own sentinel is a real failure: it means the
    -- write guards rejected the insert, which this migration must not mask.
    IF SQLERRM <> 'mig149-probe-rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_ent IS NULL THEN
    RAISE EXCEPTION 'migration 149: memories_extract_entities_trigger stopped populating entities after REVOKE';
  END IF;

  -- Report the remaining anon-reachable SECURITY DEFINER surface, so the
  -- residue is visible in the migration output instead of silent.
  SELECT count(*) INTO v_leaked
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_leaked <> 14 THEN
    RAISE EXCEPTION 'migration 149: expected exactly 14 anon-reachable SECURITY DEFINER functions to remain (all read-only), found %', v_leaked;
  END IF;

  RAISE NOTICE 'migration 149: locked % functions; % read-only SECURITY DEFINER function(s) remain anon-EXECUTE-able (tracked separately)',
    array_length(v_sigs, 1), v_leaked;
END;
$lock$;

COMMIT;
