-- ---------------------------------------------------------------------------
-- 150: revoke anon EXECUTE on the remaining SECURITY DEFINER readers
-- ---------------------------------------------------------------------------
-- Completes the surface that migration 149 deliberately left open.
--
-- 149 locked the 36 write paths and stopped there, because closing a read path
-- is a different decision from closing a write path and was Jeff's to make. He
-- approved it on 2026-09-06. This migration closes the remaining 14.
--
-- Why these matter: SECURITY DEFINER means they execute as their owner and
-- BYPASS RLS. `anon` is the role behind the publishable key -- public by design
-- and unauthenticated. So anyone holding that key could read:
--
--   * memory_health_snapshot           -- memory names, counts, health state
--   * unverified_high_recall_memories  -- memory names and content
--   * check_stale_context              -- per-agent memory state
--   * lab_health_snapshot              -- infrastructure state
--   * premise_gate_status / premise_pending  -- governance state
--   * spreading_activation_rerank / extract_entities -- memory internals
--   * apply_*_if_missing (6)           -- schema shape disclosure
--
-- The apply_*_if_missing family is named like it mutates, and that was checked
-- rather than assumed: none of the 14 function bodies contain EXECUTE, ALTER,
-- CREATE, DROP or UPDATE. They detect and return a status string. So this is
-- purely an information-disclosure closure, not a write-path one -- which is
-- also why it was safe to defer, and why it is still worth doing.
--
-- Caller blast radius, verified before writing this (the reason it is safe):
--   * dashboard/  -- zero references to any of the 14, in app/, components/
--                    or lib/. Its API routes use SUPABASE_SECRET_KEY.
--   * memory-mcp-server -- DOES call spreading_activation_rerank,
--                    check_stale_context and unverified_high_recall_memories,
--                    but its client is built at src/index.ts:144 with
--                    SUPABASE_SECRET_KEY (service_role). SUPABASE_PUBLISHABLE_KEY
--                    appears only at src/index.ts:3937, building the realtime
--                    WebSocket URL, which does not call RPC.
--   service_role is not affected by revoking anon, so no known caller loses
--   access. The verify block below proves service_role retains EXECUTE.
--
-- Two distinct grant sources, same as 149 -- fixing only one is the classic
-- mistake:
--   1. `=X/postgres`  -- implicit PUBLIC grant on every new function.
--                        Removed by REVOKE ... FROM PUBLIC.
--   2. `anon=X/...`   -- EXPLICIT grant from Supabase's ALTER DEFAULT
--                        PRIVILEGES. REVOKE FROM PUBLIC does NOT touch it;
--                        anon must be revoked BY NAME.
--
-- Template: migration 149.
-- ---------------------------------------------------------------------------

BEGIN;

-- Declared once, driving both the revoke and the verification, so the two
-- cannot drift apart.
DO $lock$
DECLARE
  v_sig     text;
  v_sigs    text[] := ARRAY[
     'public.apply_agent_episodes_if_missing()'
    ,'public.apply_drop_10arg_overload_if_present()'
    ,'public.apply_entity_linking_if_missing()'
    ,'public.apply_topic_hint_if_missing()'
    ,'public.apply_weibull_decay_entity_if_missing()'
    ,'public.apply_weibull_decay_if_missing()'
    -- NOTE: types only, no parameter names. to_regprocedure() rejects named
    -- parameters ("invalid type name \"p_agent_name text\""), so a signature
    -- copied from pg_get_function_identity_arguments() will fail to resolve.
    -- Use oidvectortypes(proargtypes). Migration 149 got this right; the first
    -- draft of 150 did not, and the resolve-guard above caught it before any
    -- REVOKE ran -- which is exactly why that guard exists.
    ,'public.check_stale_context(text, uuid[])'
    ,'public.extract_entities(text)'
    ,'public.lab_health_snapshot()'
    ,'public.memory_health_snapshot()'
    ,'public.premise_gate_status(uuid)'
    ,'public.premise_pending()'
    ,'public.spreading_activation_rerank(uuid[], double precision[], double precision, integer)'
    ,'public.unverified_high_recall_memories(integer, double precision, integer, integer)'
  ];
  v_missing text[] := '{}';
  v_norole  text[] := '{}';
  v_leaked  int;
BEGIN
  -- Every signature must resolve. A typo would otherwise revoke nothing and
  -- report success -- the silent-failure shape this lab keeps getting bitten by.
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_missing := v_missing || v_sig;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'migration 150: % signature(s) did not resolve: %',
      array_length(v_missing, 1), array_to_string(v_missing, ', ');
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;

  -- Prove anon actually lost EXECUTE on each one.
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
      v_norole := v_norole || v_sig;
    END IF;
  END LOOP;

  IF array_length(v_norole, 1) > 0 THEN
    RAISE EXCEPTION 'migration 150: anon still holds EXECUTE on: %',
      array_to_string(v_norole, ', ');
  END IF;

  -- ...and that service_role did NOT, since memory-mcp calls three of these on
  -- the recall path. Breaking recall to close a disclosure hole is not a trade
  -- worth making silently.
  v_norole := '{}';
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF NOT has_function_privilege('service_role', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
      v_norole := v_norole || v_sig;
    END IF;
  END LOOP;

  IF array_length(v_norole, 1) > 0 THEN
    RAISE EXCEPTION 'migration 150: service_role LOST EXECUTE on: % -- this would break memory-mcp recall',
      array_to_string(v_norole, ', ');
  END IF;

  -- The whole point: the anon-reachable SECURITY DEFINER surface is now empty.
  SELECT count(*) INTO v_leaked
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_leaked <> 0 THEN
    RAISE EXCEPTION 'migration 150: expected 0 anon-reachable SECURITY DEFINER functions, found %', v_leaked;
  END IF;

  RAISE NOTICE 'migration 150: locked % readers; anon-reachable SECURITY DEFINER surface is now 0 (was 50 before migration 149)',
    array_length(v_sigs, 1);
END;
$lock$;

COMMIT;
