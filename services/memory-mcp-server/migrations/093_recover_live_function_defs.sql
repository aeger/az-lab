-- 093_recover_live_function_defs.sql
-- 2026-08-01 daily research, REC 1 (data-loss recovery). RECOVERY ARTIFACT.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- The live retrieval ranker existed ONLY inside Supabase. It was in no git
-- object and in no backup:
--
--   * `hybrid_recall` live body = 21,957 chars of prosrc, contains IDF logic.
--     `grep -rn "idf_adaptive|idf_strength|IDF_STRENGTH" src/ migrations/`
--     -> 0 hits. The body on disk (086/091) is NOT the body that runs.
--   * supabase_migrations.schema_migrations records three migrations with no
--     disk artifact at all -- they were applied direct-SQL:
--       20260731163837  093a_idf_stats_and_lane_weight_columns
--       20260731164031  093b_hybrid_recall_idf_adaptive_lanes
--       20260731164739  094_eval_failure_mode_attribution
--   * 26 live public functions have no CREATE FUNCTION anywhere in the repo:
--       auto_detect_conflicts, auto_enable_rls_on_create, check_kill_switch,
--       delete_credential, extract_facts_from_content, find_duplicate_memories,
--       find_stale_memories, get_credential, get_linked_memories,
--       handle_task_failure, lab_health_snapshot, list_credentials,
--       log_memory_change, match_memories (x2), merge_memory_into,
--       query_idf_norm, queue_blocked_task, refresh_lexeme_doc_freq,
--       set_updated_at, task_queue_set_trace_id, update_goal_progress_from_tasks,
--       update_updated_at, upsert_agent_heartbeat, upsert_credential,
--       upsert_grimoire_daily_stats, verify_admin_token
--   * services/backups/bin/supabase-export.py enumerates public tables via the
--     PostgREST OpenAPI spec and writes <table>.json.gz. Rows only. It has
--     never touched function DDL. Rows without schema is not a restorable backup.
--
-- A Supabase rollback, a bad CREATE OR REPLACE, or project loss made the
-- 6-lane RRF + A-MAC + trust-weight ranker unrecoverable. This is provenance
-- collapse (arXiv 2606.24535) applied to the control plane.
--
-- ============================================================================
-- WHAT THIS IS
-- ============================================================================
-- A COMPLETE pg_get_functiondef() snapshot of every function and procedure in
-- schema public, captured 2026-08-01 from the live azlab-memory project
-- (ogqjjlbupqnvlcyrfnxi) at ledger head 20260731164739 / 094.
--
-- Complete, not partial, deliberately. A partial recovery leaves the exact same
-- hole this migration closes: a function whose repo definition silently drifted
-- from the live one and nobody noticed. Every body below is authoritative.
--
-- ============================================================================
-- APPLYING IT
-- ============================================================================
-- Against the live DB this is a NO-OP by construction -- each statement replaces
-- a function with its own current definition. NOT re-applied to prod, because
-- there is nothing to change. Validation performed: every body is verbatim
-- pg_get_functiondef() output (valid by construction), 121 CREATE blocks each
-- terminated, dollar-quote tags balanced. It has NOT been round-tripped through
-- a live apply.
--
-- Its purpose is RESTORE: replay against a fresh/rolled-back project after the
-- table DDL exists, to reinstate the ranker exactly as it ran on 2026-08-01.
--
-- Ongoing coverage: 095_schema_export_rpc.sql adds public.export_schema_ddl(),
-- which services/backups/bin/supabase-export.py now dumps to schema.sql.gz on
-- every nightly run. This file is the one-time backfill; the backup lane is the
-- forward fix.
--
-- STANDING RULE (adopted 2026-08-01, REC 1.4): no direct-SQL CREATE OR REPLACE
-- on a scoring function without a numbered migration file committed in the same
-- session. 093a/093b/094 all broke this inside one week -- a pattern, not a slip.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_link_type_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_links' AND column_name = 'link_type'
  ) THEN
    ALTER TABLE memory_links
    ADD COLUMN link_type text NOT NULL DEFAULT 'semantic'
    CHECK (link_type IN ('semantic', 'temporal', 'causal', 'entity'));
    RETURN 'column added';
  ELSE
    RETURN 'column already exists';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.amac_score(p_last_accessed timestamp with time zone, p_memory_class text, p_access_count integer, p_novelty double precision, p_importance double precision, p_rrf_norm double precision, p_recall_count integer, p_trust_tier text, p_superseded_by uuid, p_conflict_flagged boolean, p_w double precision[])
 RETURNS double precision
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT (
      p_w[1] * EXP(- POWER(
          GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed, now()))) / 86400.0, 0.0)
          / CASE p_memory_class WHEN 'semantic' THEN 60.0 WHEN 'episodic' THEN 7.0 WHEN 'procedural' THEN 180.0 ELSE 10.0 END,
          CASE p_memory_class WHEN 'semantic' THEN 0.70 WHEN 'episodic' THEN 1.30 WHEN 'procedural' THEN 0.50 ELSE 1.00 END
        ))
    + p_w[2] * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + p_w[3] * COALESCE(p_novelty, 0.5)
    + p_w[4] * COALESCE(p_importance, 0.5)
    + p_w[5] * LEAST(GREATEST(COALESCE(p_rrf_norm, 0.0), 0.0), 1.0)
    + p_w[6] * LEAST(LN(1.0 + COALESCE(p_recall_count, 0)::float) / LN(51.0), 1.0)
  )::float
  * public.trust_weight(p_trust_tier)
  * public.governance_weight(p_superseded_by, p_conflict_flagged)
$function$
;

CREATE OR REPLACE FUNCTION public.amac_standing_value(p_last_accessed_at timestamp with time zone, p_updated_at timestamp with time zone, p_created_at timestamp with time zone, p_access_count integer, p_novelty double precision, p_importance double precision)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  -- p_updated_at is accepted for signature stability but DELIBERATELY IGNORED.
  -- See migration 067: it is trigger-mutated and therefore not a freshness signal.
  SELECT (
      0.25 * EXP(-0.1 * GREATEST(
               EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed_at, p_created_at))) / 86400.0, 0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(p_novelty, 0.5)
    + 0.25 * COALESCE(p_importance, 0.5)
  ) / 0.85
$function$
;

CREATE OR REPLACE FUNCTION public.apply_adaptive_decay_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result text := '';
BEGIN
  -- Add last_accessed_at column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'last_accessed_at'
  ) THEN
    ALTER TABLE memories ADD COLUMN last_accessed_at timestamptz;
    UPDATE memories SET last_accessed_at = accessed_at WHERE last_accessed_at IS NULL AND accessed_at IS NOT NULL;
    v_result := v_result || 'added last_accessed_at; ';
  ELSE
    v_result := v_result || 'last_accessed_at exists; ';
  END IF;

  -- Add importance_score column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'importance_score'
  ) THEN
    ALTER TABLE memories ADD COLUMN importance_score float DEFAULT 0.5;
    v_result := v_result || 'added importance_score; ';
  ELSE
    v_result := v_result || 'importance_score exists; ';
  END IF;

  RETURN TRIM(v_result);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_agent_episodes_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'agent_episodes'
  ) THEN
    RETURN 'agent_episodes table missing — apply migrations/029_agent_episodes.sql';
  END IF;
  RETURN 'migration 029: agent_episodes + expanded conflict_type — ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_agent_scope_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'agent_scope'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 012: agent_scope column present — per-agent visibility array active';
  ELSE
    RETURN 'WARNING: agent_scope column missing — re-apply 012_agent_scope.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_agent_visibility_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'agent_id'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 011: agent_id + visibility + skills hierarchy all present';
  ELSE
    RETURN 'WARNING: agent_id column missing — re-apply 011_skills_hierarchy.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_amac_scoring_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'amac_novelty_score'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 013: amac_novelty_score present — A-MAC 5D scoring active (α=0.25 recency, β=0.20 freq, γ=0.15 novelty, δ=0.25 importance, ε=0.15 utility)';
  ELSE
    RETURN 'WARNING: amac_novelty_score missing — re-apply 013_amac_scoring.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_bm25_migration_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'search_vector') THEN
    v_result := v_result || 'search_vector column missing — run migration 007; ';
  ELSE
    v_result := v_result || 'search_vector exists (GENERATED ALWAYS); ';
  END IF;
  RETURN TRIM(v_result);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_confidence_column_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'confidence'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 026: confidence column active — confidence scoring enabled';
  ELSE
    RETURN 'WARNING: confidence column missing — re-apply 026_confidence_column.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_content_hash_if_missing()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'content_hash'
  ) THEN
    ALTER TABLE memories ADD COLUMN content_hash text DEFAULT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_content_hash'
  ) THEN
    CREATE INDEX idx_memories_content_hash ON memories(content_hash);
  END IF;
  RETURN 'ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_discard_redundant_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'discard_redundant_memories') THEN
    RETURN 'migration 025: discard_redundant_memories active';
  ELSE
    RETURN 'WARNING: discard_redundant_memories missing — re-apply 025_discard_redundant.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_drop_10arg_overload_if_present()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';
  IF v_count > 1 THEN
    RETURN format('hybrid_recall has %s overloads - expected exactly 1 after migration 045', v_count);
  END IF;
  RETURN '10-arg redundant overload dropped';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_dual_bm25_hybrid_recall_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  func_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO func_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall'
  LIMIT 1;

  IF func_body LIKE '%bm25_plain%' THEN
    RETURN 'migration 017: hybrid_recall dual-BM25 (search_vec + search_vector) RRF active';
  ELSE
    RETURN 'WARNING: hybrid_recall missing bm25_plain CTE — re-apply 017_dual_bm25_hybrid_recall.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_duplicate_conflict_type_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_constraint_def text;
BEGIN
  -- Check if 'duplicate' is already in the constraint
  SELECT pg_get_constraintdef(oid) INTO v_constraint_def
  FROM pg_constraint
  WHERE conname = 'memory_conflicts_conflict_type_check';

  IF v_constraint_def IS NULL OR v_constraint_def NOT LIKE '%duplicate%' THEN
    -- Drop and recreate the constraint with 'duplicate' included
    ALTER TABLE memory_conflicts
      DROP CONSTRAINT IF EXISTS memory_conflicts_conflict_type_check;
    ALTER TABLE memory_conflicts
      ADD CONSTRAINT memory_conflicts_conflict_type_check
      CHECK (conflict_type IN ('contradiction', 'overlap', 'stale', 'duplicate'));
    RETURN 'constraint updated to include duplicate';
  ELSE
    RETURN 'constraint already includes duplicate';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_entity_linking_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memories' AND column_name='entities'
  ) THEN
    RETURN 'entities column not yet present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='hybrid_recall'
      AND 'p_query_entities' = ANY(p.proargnames)
  ) THEN
    RETURN 'hybrid_recall entity overload missing';
  END IF;
  RETURN 'entity linking present';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_episodic_semantic_types_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_constraint_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_constraint_def
  FROM pg_constraint
  WHERE conrelid = 'memories'::regclass
    AND conname = 'memories_type_check';

  IF v_constraint_def IS NULL THEN
    ALTER TABLE memories
      ADD CONSTRAINT memories_type_check
      CHECK (type IN ('user', 'feedback', 'project', 'reference', 'episodic', 'semantic'));
    RETURN 'constraint created with episodic+semantic';
  ELSIF v_constraint_def NOT LIKE '%episodic%' THEN
    ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
    ALTER TABLE memories
      ADD CONSTRAINT memories_type_check
      CHECK (type IN ('user', 'feedback', 'project', 'reference', 'episodic', 'semantic'));
    RETURN 'constraint updated to include episodic+semantic';
  ELSE
    RETURN 'constraint already includes episodic+semantic';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_memory_class_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'memory_class'
  ) THEN
    ALTER TABLE memories ADD COLUMN memory_class text
      CHECK (memory_class IN ('episodic', 'semantic', 'procedural', 'working'));
    UPDATE memories SET memory_class = CASE WHEN type = 'episodic' THEN 'episodic' ELSE 'semantic' END
    WHERE memory_class IS NULL;
    RETURN 'memory_class column added and backfilled';
  END IF;
  RETURN 'memory_class already present';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_optimistic_locking_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'version'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 024: version column active — optimistic locking enabled';
  ELSE
    RETURN 'WARNING: version column missing — re-apply 024_optimistic_locking.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_pagerank_migration_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result text := '';
BEGIN
  -- Add pagerank_score column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'pagerank_score'
  ) THEN
    ALTER TABLE memories ADD COLUMN pagerank_score float DEFAULT 0.0;
    v_result := v_result || 'added pagerank_score column; ';
  ELSE
    v_result := v_result || 'pagerank_score column exists; ';
  END IF;

  RETURN TRIM(v_result);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_recall_count_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'recall_count'
  ) INTO col_exists;
  IF col_exists THEN
    RETURN 'migration 023: recall_count + last_accessed columns active — reinforce-on-access + 4-lane RRF + agent_scope all confirmed';
  ELSE
    RETURN 'WARNING: recall_count column missing — re-apply 023_recall_count.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_sentinel_phase4_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  CREATE TABLE IF NOT EXISTS sentinel_extension_heartbeat (
    extension_id   text PRIMARY KEY DEFAULT 'default',
    last_seen      timestamptz NOT NULL DEFAULT now(),
    user_agent     text,
    version        text,
    updated_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sentinel_guardian_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type     text NOT NULL CHECK (event_type IN ('extension_dead', 'reconnect_requested', 'self_healed', 'discord_alerted')),
    extension_id   text NOT NULL DEFAULT 'default',
    details        jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS sentinel_guardian_events_created_at_idx ON sentinel_guardian_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS sentinel_guardian_events_type_idx ON sentinel_guardian_events (event_type);

  CREATE TABLE IF NOT EXISTS sentinel_sound_suggestions (
    week_start     date PRIMARY KEY,
    suggestion     jsonb NOT NULL,
    hours_analyzed int,
    samples_used   int,
    posted_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sentinel_health_reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date    date NOT NULL UNIQUE,
    report         jsonb NOT NULL,
    posted_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
  );

  RETURN 'phase4 tables applied';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_skill_memory_links_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  tbl_exists  boolean;
  func_exists boolean;
  parts text[] := ARRAY[]::text[];
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'skill_memory_links'
  ) INTO tbl_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'link_memories_to_skills'
  ) INTO func_exists;

  parts := parts || (CASE WHEN tbl_exists  THEN 'skill_memory_links ok'
                          ELSE 'WARNING: skill_memory_links missing' END);
  parts := parts || (CASE WHEN func_exists THEN 'link_memories_to_skills ok'
                          ELSE 'WARNING: link_memories_to_skills missing' END);

  RETURN 'migration 022: ' || array_to_string(parts, ', ');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_staleness_candidate_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'staleness_candidate'
  ) THEN
    ALTER TABLE memories ADD COLUMN staleness_candidate BOOLEAN DEFAULT false;
  END IF;
  RETURN 'ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_topic_hint_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'hybrid_recall'
      AND 'p_topic_hint' = ANY(p.proargnames)
  ) THEN
    RETURN 'topic_hint not yet present — run migration 036';
  END IF;
  RETURN 'topic_hint present';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_trigram_fallback_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  func_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO func_body FROM pg_proc WHERE proname = 'hybrid_recall' LIMIT 1;
  IF func_body LIKE '%trgm_ranked%' THEN
    RETURN 'hybrid_recall already has trigram fallback (migration 009 applied)';
  ELSE
    RETURN 'WARNING: hybrid_recall missing trgm_ranked CTE — re-apply 009_trigram_fallback.sql';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_verified_at_if_missing()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'verified_at'
  ) THEN
    ALTER TABLE memories ADD COLUMN verified_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_verified_at'
  ) THEN
    CREATE INDEX idx_memories_verified_at ON memories(verified_at);
  END IF;
  RETURN 'ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_weibull_decay_entity_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname  = 'hybrid_recall'
    AND 'p_query_entities' = ANY(p.proargnames)
  LIMIT 1;

  IF v_src IS NULL THEN
    RETURN 'hybrid_recall(entity variant) not found - run migration 039 first';
  END IF;
  IF v_src NOT LIKE '%POWER(%memory_class%' THEN
    RETURN 'weibull decay missing on entity overload - run migration 044';
  END IF;
  RETURN 'weibull decay present on entity overload';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_weibull_decay_if_missing()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname  = 'hybrid_recall'
    AND 'p_topic_hint' = ANY(p.proargnames)
  LIMIT 1;

  IF v_src IS NULL THEN
    RETURN 'hybrid_recall(topic_hint variant) not found - run migration 036 first';
  END IF;
  IF v_src NOT LIKE '%POWER(%memory_class%' THEN
    RETURN 'weibull decay missing - run migration 043';
  END IF;
  RETURN 'weibull decay present';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_memory_tiers()
 RETURNS TABLE(tier text, n bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  WITH scored AS (
    SELECT m.id,
      public.amac_standing_value(
        m.last_accessed_at, m.updated_at, m.created_at,
        m.access_count, m.amac_novelty_score, m.importance_score) AS sv,
      COALESCE(m.access_count, 0) AS ac,
      m.created_at, m.type, m.memory_class, m.lifecycle_pinned
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
  ), assigned AS (
    SELECT id,
      CASE
        WHEN sv >= 0.60 OR ac >= 10 THEN 'hot'
        WHEN sv < 0.45 AND ac = 0
             AND created_at < now() - interval '60 days'
             AND type NOT IN ('user', 'feedback')          -- guard 1
             AND COALESCE(memory_class, '') <> 'procedural' -- guard 2
             AND NOT lifecycle_pinned                       -- guard 3
          THEN 'cold'
        ELSE 'warm'
      END AS new_tier
    FROM scored
  )
  UPDATE memories m
  SET memory_tier = a.new_tier, tier_assigned_at = now()
  FROM assigned a
  WHERE m.id = a.id
    AND (m.memory_tier IS DISTINCT FROM a.new_tier OR m.tier_assigned_at IS NULL);

  RETURN QUERY
    SELECT m.memory_tier, count(*)
    FROM memories m
    WHERE COALESCE(m.is_active, true) IS NOT FALSE
    GROUP BY m.memory_tier ORDER BY 1;
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.auto_detect_conflicts(p_memory_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count INTEGER := 0;
BEGIN
    INSERT INTO memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by)
    SELECT
        LEAST(p_memory_id, m.id),
        GREATEST(p_memory_id, m.id),
        'duplicate',
        'Vector similarity ' || round((1 - (new_m.embedding <=> m.embedding))::NUMERIC, 3)::TEXT || ' exceeds threshold 0.92',
        'auto_detect_conflicts'
    FROM memories new_m, memories m
    WHERE new_m.id = p_memory_id
      AND m.id != p_memory_id
      AND m.embedding IS NOT NULL
      AND new_m.embedding IS NOT NULL
      AND 1 - (new_m.embedding <=> m.embedding) > 0.92
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_enable_rls_on_create()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  obj record;
  qualified_name text;
BEGIN
  FOR obj IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag = 'CREATE TABLE'
      AND schema_name = 'public'
      AND object_type = 'table'
  LOOP
    qualified_name := obj.objid::regclass::text;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', qualified_name);
    EXECUTE format(
      'CREATE POLICY %I ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)',
      '_service_role_bypass',
      qualified_name
    );
    RAISE NOTICE 'auto_rls: enabled RLS + service_role bypass on %', qualified_name;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_kill_switch(p_agent text DEFAULT NULL::text)
 RETURNS TABLE(halted boolean, scope text, reason text, severity text, tripped_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT true, ks.scope, ks.reason, ks.severity, ks.tripped_at
  FROM kill_switches ks
  WHERE ks.active = true
    AND (ks.scope = 'global' OR ks.scope = p_agent)
  ORDER BY ks.tripped_at DESC
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.check_stale_context(p_agent_name text, p_memory_ids uuid[])
 RETURNS TABLE(memory_id uuid, memory_name text, action text, last_modified_at timestamp with time zone, changed_by text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_watermark TIMESTAMPTZ;
BEGIN
  SELECT last_seen_at INTO v_watermark
  FROM public.agent_read_watermarks
  WHERE agent_name = p_agent_name;

  IF v_watermark IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (ml.memory_id)
    ml.memory_id,
    m.name,
    ml.action,
    ml.created_at,
    ml.source
  FROM public.memory_log ml
  LEFT JOIN public.memories m ON m.id = ml.memory_id
  WHERE ml.memory_id = ANY(p_memory_ids)
    AND ml.created_at > v_watermark
    AND ml.source IS DISTINCT FROM p_agent_name
  ORDER BY ml.memory_id, ml.created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.compute_pagerank(damping double precision DEFAULT 0.85, iterations integer DEFAULT 10)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int;
  i int;
  updated int;
BEGIN
  PERFORM set_config('statement_timeout', '300000', true);

  SELECT COUNT(*) INTO n FROM memories;
  IF n = 0 THEN RETURN 0; END IF;

  -- Iterate entirely in a temp table to avoid per-iteration triggers (audit + updated_at).
  CREATE TEMP TABLE _pr_score (id uuid PRIMARY KEY, score float NOT NULL) ON COMMIT DROP;
  INSERT INTO _pr_score (id, score)
    SELECT id, 1.0 / n FROM memories;

  CREATE TEMP TABLE _pr_out (source_id uuid PRIMARY KEY, cnt float NOT NULL) ON COMMIT DROP;
  INSERT INTO _pr_out (source_id, cnt)
    SELECT source_id, COUNT(*)::float FROM memory_links GROUP BY source_id;

  FOR i IN 1..iterations LOOP
    WITH incoming AS (
      SELECT ml.target_id AS id,
             SUM(s.score / o.cnt) AS contrib
      FROM memory_links ml
      JOIN _pr_score s ON s.id = ml.source_id
      JOIN _pr_out   o ON o.source_id = ml.source_id
      GROUP BY ml.target_id
    )
    UPDATE _pr_score t
    SET score = (1.0 - damping) / n + damping * COALESCE(inc.contrib, 0.0)
    FROM (SELECT id FROM _pr_score) all_ids
    LEFT JOIN incoming inc ON inc.id = all_ids.id
    WHERE t.id = all_ids.id;
  END LOOP;

  -- Single bulk UPDATE on the real table — fires audit trigger only n times instead of n*iterations
  UPDATE memories m
  SET pagerank_score = s.score
  FROM _pr_score s
  WHERE m.id = s.id AND m.pagerank_score IS DISTINCT FROM s.score;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.consolidate_similar_memories(p_threshold double precision DEFAULT 0.90, p_dry_run boolean DEFAULT false, p_episodic_gate double precision DEFAULT 0.95)
 RETURNS TABLE(merged_count integer, deleted_ids uuid[], keeper_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_deleted  uuid[] := '{}';
  v_keepers  uuid[] := '{}';
  v_merged   int    := 0;
  r          record;
BEGIN
  FOR r IN
    SELECT
      a.id       AS id_a,
      b.id       AS id_b,
      a.name     AS name_a,
      b.name     AS name_b,
      a.content  AS content_a,
      b.content  AS content_b,
      a.tags     AS tags_a,
      b.tags     AS tags_b,
      a.memory_class AS class_a,
      b.memory_class AS class_b,
      COALESCE(a.importance_score, 0.5) AS imp_a,
      COALESCE(b.importance_score, 0.5) AS imp_b,
      1.0 - (a.embedding::vector <=> b.embedding::vector) AS cosine_sim
    FROM memories a
    JOIN memories b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND a.type = b.type
      AND (1.0 - (a.embedding::vector <=> b.embedding::vector)) > p_threshold
      AND a.id <> ALL(v_deleted)
      AND b.id <> ALL(v_deleted)
    ORDER BY cosine_sim DESC
    LIMIT 200
  LOOP
    IF r.id_a = ANY(v_deleted) OR r.id_b = ANY(v_deleted) THEN
      CONTINUE;
    END IF;

    IF (r.class_a = 'episodic' OR r.class_b = 'episodic')
       AND r.cosine_sim < p_episodic_gate THEN
      CONTINUE;
    END IF;

    DECLARE
      v_keeper_id  uuid;
      v_delete_id  uuid;
      v_keep_cont  text;
      v_del_cont   text;
      v_merged_tags text[];
    BEGIN
      IF r.imp_a >= r.imp_b THEN
        v_keeper_id := r.id_a; v_keep_cont := r.content_a;
        v_delete_id := r.id_b; v_del_cont  := r.content_b;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_a || COALESCE(r.tags_b, '{}'::text[])));
      ELSE
        v_keeper_id := r.id_b; v_keep_cont := r.content_b;
        v_delete_id := r.id_a; v_del_cont  := r.content_a;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_b || COALESCE(r.tags_a, '{}'::text[])));
      END IF;

      IF NOT p_dry_run THEN
        IF v_keep_cont NOT LIKE '%' || LEFT(v_del_cont, 60) || '%' THEN
          UPDATE memories
          SET content  = v_keep_cont || E'\n\n[Consolidated from: ' || r.name_a || ' / ' || r.name_b || E']\n' || v_del_cont,
              tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        ELSE
          UPDATE memories
          SET tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        END IF;

        INSERT INTO memory_log(memory_id, action, details, created_at)
        VALUES (v_delete_id, 'consolidated',
          jsonb_build_object(
            'keeper_id',     v_keeper_id,
            'cosine_sim',    r.cosine_sim,
            'threshold',     p_threshold,
            'episodic_gate', p_episodic_gate,
            'class_a',       r.class_a,
            'class_b',       r.class_b
          ),
          now()
        ) ON CONFLICT DO NOTHING;

        DELETE FROM memories WHERE id = v_delete_id;
      END IF;

      v_deleted := v_deleted || v_delete_id;
      v_keepers := v_keepers || v_keeper_id;
      v_merged  := v_merged + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_merged, v_deleted, v_keepers;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.content_timestamp(p_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(
    (SELECT m.created_at FROM memories m WHERE m.id = p_id),
    COALESCE((SELECT max(l.created_at) FROM memory_log l
               WHERE l.memory_id = p_id AND l.action IN ('create', 'update')),
             (SELECT m.created_at FROM memories m WHERE m.id = p_id))
  )
$function$
;

CREATE OR REPLACE FUNCTION public.delete_credential(p_admin_token text, p_name text, p_caller text DEFAULT 'unknown'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT verify_admin_token(p_admin_token) THEN
        INSERT INTO credential_access_log (credential_name, accessed_by, action, success, detail)
        VALUES (p_name, p_caller, 'delete', false, 'invalid admin token');
        RAISE EXCEPTION 'unauthorized: invalid admin token';
    END IF;

    DELETE FROM credentials WHERE name = p_name;

    INSERT INTO credential_access_log (credential_name, accessed_by, action, success)
    VALUES (p_name, p_caller, 'delete', true);

    RETURN 'ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_trust_tier(p_source text, p_writer_agent text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- 1. Exact, direct-write sources — unchanged from migration 041.
    WHEN lower(coalesce(p_source, '')) = 'manual'      THEN 'verified'
    WHEN lower(coalesce(p_source, '')) = 'claude-code' THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'wren'        THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'forge'       THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'atlas'       THEN 'high'
    WHEN lower(coalesce(p_source, '')) = 'claude-ai'   THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'iris'        THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'volt'        THEN 'medium'
    WHEN lower(coalesce(p_source, '')) = 'hermes'      THEN 'medium'

    -- 2. Attributable but indirect: a first-party agent appears as a source
    --    prefix, or writer_agent names one. Automation run by a known agent.
    WHEN lower(coalesce(p_source, '')) ~
         '^(wren|iris|atlas|forge|volt|hermes|cowork|claude-code|claude-ai|dispatch)([-_].*)?$'
      THEN 'medium'
    WHEN lower(coalesce(p_writer_agent, '')) ~
         '^(wren|iris|atlas|forge|volt|hermes|cowork|claude-code|claude-ai|dispatch)([-_].*)?$'
      THEN 'medium'

    -- 3. No agent prefix, no writer_agent: an unattributed direct write.
    WHEN coalesce(nullif(trim(p_writer_agent), ''), '') = '' THEN 'low'

    -- 4. writer_agent set but not a recognised agent — attributable to
    --    *something*, just not to us. Below medium, above unattributed.
    ELSE 'low'
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_trust_tier(p_source text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.derive_trust_tier(p_source, NULL);
$function$
;

CREATE OR REPLACE FUNCTION public.derive_writer_agent_from_source(p_source text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  s text := lower(coalesce(p_source, ''));
  agents text[] := ARRAY['wren','iris','atlas','forge','volt','hermes','lumen'];
  a text;
BEGIN
  IF s = '' THEN RETURN NULL; END IF;
  FOREACH a IN ARRAY agents LOOP
    IF s = a THEN RETURN a; END IF;
  END LOOP;
  FOREACH a IN ARRAY agents LOOP
    IF s ~ ('(^|[^a-z0-9])' || a || '([^a-z0-9]|$)') THEN
      RETURN a;
    END IF;
  END LOOP;
  IF s = 'claude-ai' OR s = 'cowork' OR s LIKE 'cowork-%' THEN RETURN 'iris'; END IF;
  IF s = 'claude-code' OR s = 'consolidation' OR s = 'dreaming_consolidate'
     OR s LIKE '%-trigger' OR s LIKE 'ccr-%' OR s LIKE 'daily-%' THEN
    RETURN 'wren';
  END IF;
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.detect_temporal_supersession(p_max_groups integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_groups    integer := 0;
  v_superseded integer := 0;
  g RECORD;
  o RECORD;
  v_newest uuid;
  v_newest_ts timestamptz;
BEGIN
  FOR g IN
    SELECT name, writer_agent, type
    FROM memories
    WHERE superseded_by IS NULL
      AND coalesce(expires_at,'infinity'::timestamptz) > now()
      AND writer_agent IS NOT NULL
      AND name !~ '(\d{4}-\d{2}-\d{2}|(19|20)\d{6})'
    GROUP BY name, writer_agent, type
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT p_max_groups
  LOOP
    v_groups := v_groups + 1;
    SELECT id, created_at INTO v_newest, v_newest_ts
    FROM memories
    WHERE name = g.name AND writer_agent = g.writer_agent AND type = g.type
      AND superseded_by IS NULL
      AND coalesce(expires_at,'infinity'::timestamptz) > now()
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    FOR o IN
      SELECT id, created_at FROM memories
      WHERE name = g.name AND writer_agent = g.writer_agent AND type = g.type
        AND superseded_by IS NULL
        AND coalesce(expires_at,'infinity'::timestamptz) > now()
        AND id <> v_newest
    LOOP
      PERFORM public.supersede_memory(o.id, v_newest,
        format('temporal_supersession: same-name %s "%s" by %s superseded by newest copy (%s)',
          g.type, g.name, g.writer_agent, to_char(v_newest_ts,'YYYY-MM-DD')),
        'last_writer_wins');
      v_superseded := v_superseded + 1;

      INSERT INTO memory_conflicts
        (memory_a_id, memory_b_id, conflict_type, description, detected_by,
         resolved, resolved_at, resolved_by, resolution_notes, resolution_heuristic)
      VALUES (o.id, v_newest, 'temporal_supersession',
        format('Same-name %s "%s" (%s): older copy superseded by newest.',
          g.type, g.name, g.writer_agent),
        'temporal-supersession', true, now(), 'temporal-supersession',
        'auto-resolved: soft supersede via supersede_memory (reversible)', 'last_writer_wins')
      ON CONFLICT (memory_a_id, memory_b_id) DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'groups_examined', v_groups,
    'rows_superseded', v_superseded,
    'live_superseded_total', (SELECT count(*) FROM memories WHERE superseded_by IS NOT NULL)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.discard_redundant_memories(p_similarity_threshold double precision DEFAULT 0.92, p_max_discards integer DEFAULT 10, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(discarded_name text, kept_name text, similarity double precision, discarded_score double precision, kept_score double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair     RECORD;
  v_deleted  INTEGER := 0;
  v_a_score  FLOAT;
  v_b_score  FLOAT;
  v_worse_id uuid;
  v_worse_name text;
  v_better_name text;
  v_sim FLOAT;
BEGIN
  FOR v_pair IN (
    SELECT
      a.id AS a_id, a.name AS a_name,
      b.id AS b_id, b.name AS b_name,
      1.0 - (a.embedding::vector <=> b.embedding::vector) AS cosine_sim
    FROM memories a
    JOIN memories b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND (1.0 - (a.embedding::vector <=> b.embedding::vector)) >= p_similarity_threshold
    ORDER BY cosine_sim DESC
    LIMIT p_max_discards * 2
  ) LOOP
    EXIT WHEN v_deleted >= p_max_discards;

    SELECT
      COALESCE(m.importance_score, 0.5) * 0.5
      + LEAST(COALESCE(m.recall_count, 0)::float / 10.0, 1.0) * 0.3
      + LEAST(COALESCE(m.access_count, 0)::float / 20.0, 1.0) * 0.2
    INTO v_a_score FROM memories m WHERE m.id = v_pair.a_id;

    SELECT
      COALESCE(m.importance_score, 0.5) * 0.5
      + LEAST(COALESCE(m.recall_count, 0)::float / 10.0, 1.0) * 0.3
      + LEAST(COALESCE(m.access_count, 0)::float / 20.0, 1.0) * 0.2
    INTO v_b_score FROM memories m WHERE m.id = v_pair.b_id;

    IF v_a_score <= v_b_score THEN
      v_worse_id   := v_pair.a_id;
      v_worse_name := v_pair.a_name;
      v_better_name := v_pair.b_name;
    ELSE
      v_worse_id   := v_pair.b_id;
      v_worse_name := v_pair.b_name;
      v_better_name := v_pair.a_name;
    END IF;

    v_sim := v_pair.cosine_sim;

    IF NOT p_dry_run THEN
      UPDATE memory_links SET source_id = CASE WHEN v_worse_id = source_id
        THEN CASE WHEN v_a_score <= v_b_score THEN v_pair.b_id ELSE v_pair.a_id END
        ELSE source_id END,
        target_id = CASE WHEN v_worse_id = target_id
        THEN CASE WHEN v_a_score <= v_b_score THEN v_pair.b_id ELSE v_pair.a_id END
        ELSE target_id END
      WHERE source_id = v_worse_id OR target_id = v_worse_id;

      DELETE FROM memories WHERE id = v_worse_id;
    END IF;

    discarded_name  := v_worse_name;
    kept_name       := v_better_name;
    similarity      := v_sim;
    discarded_score := LEAST(v_a_score, v_b_score);
    kept_score      := GREATEST(v_a_score, v_b_score);
    RETURN NEXT;

    v_deleted := v_deleted + 1;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_infra_remediation_routing()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.source = 'cowork'
     AND NEW.target = 'cowork'
     AND public.task_needs_host_remediation(
           NEW.title, NEW.description, NEW.context, NEW.tags)
  THEN
    NEW.target := 'claude-code';
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
$function$
;

CREATE OR REPLACE FUNCTION public.eval_access_snapshot_restore()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE memories m
  SET access_count     = s.access_count,
      recall_count     = s.recall_count,
      accessed_at      = s.accessed_at,
      last_accessed_at = s.last_accessed_at,
      last_accessed    = s.last_accessed
  FROM public.eval_access_snapshot s
  WHERE m.id = s.id
    AND (m.access_count     IS DISTINCT FROM s.access_count
      OR m.recall_count     IS DISTINCT FROM s.recall_count
      OR m.last_accessed_at IS DISTINCT FROM s.last_accessed_at);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.eval_access_snapshot_take()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  TRUNCATE public.eval_access_snapshot;
  INSERT INTO public.eval_access_snapshot
    (id, access_count, recall_count, accessed_at, last_accessed_at, last_accessed)
  SELECT id, access_count, recall_count, accessed_at, last_accessed_at, last_accessed
  FROM memories;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.export_schema_ddl()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  out_txt text := '';
BEGIN
  out_txt := out_txt || E'-- ============================================================\n'
                     || E'-- azlab-memory schema DDL snapshot\n'
                     || E'-- Generated by public.export_schema_ddl()\n'
                     || E'-- ============================================================\n\n';

  out_txt := out_txt || E'\n-- ===================== EXTENSIONS =====================\n';
  SELECT out_txt || coalesce(string_agg(
           format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I;', e.extname, n.nspname),
           E'\n' ORDER BY e.extname), '')
    INTO out_txt
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace;

  out_txt := out_txt || E'\n\n-- ===================== TABLES =====================\n';
  SELECT out_txt || coalesce(string_agg(t.ddl, E'\n\n' ORDER BY t.relname), '') INTO out_txt
  FROM (
    SELECT c.relname,
           format(E'-- table: %I\nCREATE TABLE IF NOT EXISTS public.%I (\n%s\n);',
             c.relname, c.relname,
             (SELECT string_agg(
                        format('  %I %s%s%s', a.attname,
                               format_type(a.atttypid, a.atttypmod),
                               CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                               CASE WHEN ad.adbin IS NOT NULL
                                    THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
                                    ELSE '' END),
                        E',\n' ORDER BY a.attnum)
                FROM pg_attribute a
                LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)) AS ddl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) t;

  out_txt := out_txt || E'\n\n-- ===================== CONSTRAINTS =====================\n';
  SELECT out_txt || coalesce(string_agg(
           format('ALTER TABLE public.%I ADD CONSTRAINT %I %s;',
                  cl.relname, con.conname, pg_get_constraintdef(con.oid)),
           E'\n' ORDER BY cl.relname, con.conname), '') INTO out_txt
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public';

  out_txt := out_txt || E'\n\n-- ===================== INDEXES =====================\n';
  SELECT out_txt || coalesce(string_agg(pg_get_indexdef(i.indexrelid) || ';',
                                        E'\n' ORDER BY ic.relname), '') INTO out_txt
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
   WHERE n.nspname = 'public' AND NOT i.indisprimary
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conindid = i.indexrelid);

  out_txt := out_txt || E'\n\n-- ===================== VIEWS =====================\n';
  SELECT out_txt || coalesce(string_agg(
           format(E'CREATE OR REPLACE VIEW public.%I AS\n%s',
                  c.relname, pg_get_viewdef(c.oid, true)),
           E'\n\n' ORDER BY c.relname), '') INTO out_txt
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('v','m');

  out_txt := out_txt || E'\n\n-- ===================== FUNCTIONS =====================\n';
  SELECT out_txt || coalesce(string_agg(pg_get_functiondef(p.oid) || E';\n',
                    E'\n' ORDER BY p.proname, p.oid::regprocedure::text), '') INTO out_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p');

  out_txt := out_txt || E'\n\n-- ===================== TRIGGERS =====================\n';
  SELECT out_txt || coalesce(string_agg(pg_get_triggerdef(tg.oid) || ';',
                                        E'\n' ORDER BY cl.relname, tg.tgname), '') INTO out_txt
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public' AND NOT tg.tgisinternal;

  out_txt := out_txt || E'\n\n-- ===================== RLS POLICIES =====================\n';
  SELECT out_txt || coalesce(string_agg(
           format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
                  pol.polname, cl.relname,
                  CASE pol.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                  WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
                  coalesce((SELECT string_agg(quote_ident(rolname), ', ')
                              FROM pg_roles WHERE oid = ANY(pol.polroles)), 'PUBLIC'),
                  coalesce(' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')', ''),
                  coalesce(' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')', '')),
           E'\n' ORDER BY cl.relname, pol.polname), '') INTO out_txt
    FROM pg_policy pol
    JOIN pg_class cl ON cl.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public';

  RETURN out_txt || E'\n';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.extract_entities(p_text text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_canonicals TEXT[];
BEGIN
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  SELECT COALESCE(array_agg(DISTINCT COALESCE(canonical, lower(entity))), ARRAY[]::TEXT[])
    INTO v_canonicals
  FROM public.entity_dictionary d
  WHERE p_text ~* ('\m' || regexp_replace(d.entity, '([.+*?^${}()|\[\]\\])', '\\\1', 'g') || '\M');

  RETURN v_canonicals;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.extract_facts_from_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_text       text;
  v_entities   text[];
  v_hashtags   text[];
  v_urls       text[];
  v_ips        text[];
  v_hostnames  text[];
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.content     IS NOT DISTINCT FROM OLD.content
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.name        IS NOT DISTINCT FROM OLD.name THEN
    RETURN NEW;
  END IF;

  v_text := COALESCE(NEW.name, '') || E'\n' ||
            COALESCE(NEW.description, '') || E'\n' ||
            COALESCE(NEW.content, '');

  SELECT ARRAY(SELECT DISTINCT lower(m[1])
               FROM regexp_matches(v_text, '\m([a-z][a-z0-9]*-[a-z0-9-]+)\M', 'g') AS t(m))
    INTO v_hostnames;
  SELECT ARRAY(SELECT DISTINCT lower(m[1])
               FROM regexp_matches(v_text, '#([A-Za-z][A-Za-z0-9_-]+)', 'g') AS t(m))
    INTO v_hashtags;
  SELECT ARRAY(SELECT DISTINCT m[1]
               FROM regexp_matches(v_text, '(https?://[^\s)>\]]+)', 'g') AS t(m))
    INTO v_urls;
  SELECT ARRAY(SELECT DISTINCT m[1]
               FROM regexp_matches(v_text, '\m((?:\d{1,3}\.){3}\d{1,3})\M', 'g') AS t(m))
    INTO v_ips;

  v_entities := COALESCE(v_hostnames, '{}') || COALESCE(v_hashtags, '{}') || COALESCE(v_ips, '{}');

  NEW.extracted_facts := jsonb_build_object(
    'entities',  to_jsonb(v_entities),
    'hostnames', to_jsonb(v_hostnames),
    'hashtags',  to_jsonb(v_hashtags),
    'urls',      to_jsonb(v_urls),
    'ips',       to_jsonb(v_ips),
    'method',    'heuristic_v1'
  );
  NEW.facts_extracted_at := now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.find_duplicate_memories(similarity_threshold double precision DEFAULT 0.90, max_pairs integer DEFAULT 20)
 RETURNS TABLE(memory_a_id uuid, memory_a_name text, memory_b_id uuid, memory_b_name text, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    m1.id  AS memory_a_id,
    m1.name AS memory_a_name,
    m2.id  AS memory_b_id,
    m2.name AS memory_b_name,
    1 - (m1.embedding <=> m2.embedding) AS similarity
  FROM memories m1
  JOIN memories m2 ON m1.id < m2.id
  WHERE m1.embedding IS NOT NULL
    AND m2.embedding IS NOT NULL
    AND (1 - (m1.embedding <=> m2.embedding)) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT max_pairs;
$function$
;

CREATE OR REPLACE FUNCTION public.find_stale_memories(days_inactive integer DEFAULT 60, max_uses integer DEFAULT 1, result_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, name text, type text, description text, source text, access_count integer, accessed_at timestamp with time zone, updated_at timestamp with time zone, link_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    m.id,
    m.name,
    m.type,
    m.description,
    m.source,
    m.access_count,
    m.accessed_at,
    m.updated_at,
    COUNT(ml.id) AS link_count
  FROM memories m
  LEFT JOIN memory_links ml ON ml.source_id = m.id
  WHERE
    m.conflict_flagged = FALSE
    AND m.access_count <= max_uses
    AND (m.accessed_at IS NULL OR m.accessed_at < now() - make_interval(days => days_inactive))
    AND (m.updated_at IS NULL  OR m.updated_at  < now() - make_interval(days => days_inactive))
  GROUP BY m.id
  HAVING COUNT(ml.id) = 0
  ORDER BY m.updated_at ASC NULLS FIRST
  LIMIT result_limit;
$function$
;

CREATE OR REPLACE FUNCTION public.flag_stale_memories()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  flagged_count integer;
BEGIN
  UPDATE memories m
  SET staleness_candidate = public.memory_is_stale(
        m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time)
  WHERE COALESCE(m.is_active, true) IS NOT FALSE
    AND COALESCE(m.staleness_candidate, false)
        IS DISTINCT FROM public.memory_is_stale(
              m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time);

  GET DIAGNOSTICS flagged_count = ROW_COUNT;
  RETURN flagged_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_credential(p_name text, p_master_key text, p_caller text DEFAULT 'unknown'::text)
 RETURNS TABLE(name text, type text, username text, secret text, host text, port integer, notes text, tags text[], projects text[], agents text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
    v_id UUID;
    v_success BOOLEAN := false;
    v_detail TEXT;
BEGIN
    SELECT c.id INTO v_id FROM credentials c WHERE c.name = p_name;

    IF v_id IS NULL THEN
        INSERT INTO credential_access_log (credential_name, accessed_by, action, success, detail)
        VALUES (p_name, p_caller, 'read', false, 'not found');
        RETURN;
    END IF;

    BEGIN
        RETURN QUERY
        SELECT
            c.name, c.type, c.username,
            pgp_sym_decrypt(c.secret_enc, p_master_key)::text,
            c.host, c.port, c.notes, c.tags, c.projects, c.agents
        FROM credentials c WHERE c.id = v_id;
        v_success := true;
    EXCEPTION WHEN OTHERS THEN
        v_detail := 'decryption failed: ' || SQLERRM;
        INSERT INTO credential_access_log (credential_id, credential_name, accessed_by, action, success, detail)
        VALUES (v_id, p_name, p_caller, 'read', false, v_detail);
        RETURN;
    END;

    UPDATE credentials SET last_accessed_at = now(), last_accessed_by = p_caller WHERE id = v_id;
    INSERT INTO credential_access_log (credential_id, credential_name, accessed_by, action, success)
    VALUES (v_id, p_name, p_caller, 'read', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_linked_memories(memory_id uuid, max_depth integer DEFAULT 2)
 RETURNS TABLE(id uuid, name text, description text, relationship text, strength double precision, depth integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH RECURSIVE link_graph AS (
    -- Seed: direct links from source
    SELECT
      CASE WHEN ml.source_id = memory_id THEN ml.target_id ELSE ml.source_id END AS mem_id,
      ml.relationship,
      ml.strength,
      1 AS depth
    FROM memory_links ml
    WHERE ml.source_id = memory_id OR ml.target_id = memory_id

    UNION ALL

    -- Recursive: follow links up to max_depth
    SELECT
      CASE WHEN ml.source_id = lg.mem_id THEN ml.target_id ELSE ml.source_id END,
      ml.relationship,
      ml.strength * 0.7,  -- Attenuate strength with each hop
      lg.depth + 1
    FROM memory_links ml
    JOIN link_graph lg ON (ml.source_id = lg.mem_id OR ml.target_id = lg.mem_id)
    WHERE lg.depth < max_depth
      AND CASE WHEN ml.source_id = lg.mem_id THEN ml.target_id ELSE ml.source_id END != memory_id
  )
  SELECT DISTINCT ON (lg.mem_id)
    m.id,
    m.name,
    m.description,
    lg.relationship,
    lg.strength,
    lg.depth
  FROM link_graph lg
  JOIN memories m ON m.id = lg.mem_id
  ORDER BY lg.mem_id, lg.depth, lg.strength DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.governance_weight(p_superseded_by uuid, p_conflict_flagged boolean)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT (CASE WHEN p_superseded_by IS NOT NULL THEN 0.55 ELSE 1.00 END
        * CASE WHEN COALESCE(p_conflict_flagged, false) THEN 0.75 ELSE 1.00 END)::double precision
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.handle_task_failure(p_task_id uuid, p_agent text, p_failure_mode text, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_task          task_queue%ROWTYPE;
  v_new_count     INTEGER;
  v_loop_detected BOOLEAN := FALSE;
  v_outcome       TEXT;
  v_history_entry JSONB;
BEGIN
  -- Lock the row for update
  SELECT * INTO v_task FROM task_queue WHERE id = p_task_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % not found', p_task_id;
  END IF;

  -- Build history entry for this attempt
  v_history_entry := jsonb_build_object(
    'attempt',      v_task.attempt_count + 1,
    'agent',        p_agent,
    'failure_mode', p_failure_mode,
    'reason',       p_reason,
    'timestamp',    now()
  );

  v_new_count := v_task.attempt_count + 1;

  -- GUARD 1: Check expiry first (hard deadline)
  IF v_task.expires_at IS NOT NULL AND v_task.expires_at < now() THEN
    UPDATE task_queue SET
      status          = 'expired',
      attempt_count   = v_new_count,
      failure_mode    = p_failure_mode,
      blocked_reason  = p_reason,
      failure_history = v_task.failure_history || v_history_entry,
      updated_at      = now()
    WHERE id = p_task_id;
    RETURN 'expired';
  END IF;

  -- GUARD 2: Loop detection — same failure_mode repeated consecutively
  IF v_task.failure_mode IS NOT NULL
     AND v_task.failure_mode = p_failure_mode
     AND p_failure_mode != 'unknown' THEN
    v_loop_detected := TRUE;
  END IF;

  IF v_loop_detected THEN
    UPDATE task_queue SET
      status          = 'blocked',
      attempt_count   = v_new_count,
      failure_mode    = 'loop_detected',
      blocked_reason  = 'Loop detected: same failure_mode (' || p_failure_mode || ') repeated. Original: ' || COALESCE(p_reason, ''),
      failure_history = v_task.failure_history || v_history_entry,
      updated_at      = now()
    WHERE id = p_task_id;
    RETURN 'blocked_loop';
  END IF;

  -- GUARD 3: Max attempts ceiling
  IF v_new_count >= v_task.max_attempts THEN
    UPDATE task_queue SET
      status          = 'escalated',
      attempt_count   = v_new_count,
      failure_mode    = p_failure_mode,
      blocked_reason  = p_reason,
      failure_history = v_task.failure_history || v_history_entry,
      escalated_at    = now(),
      updated_at      = now()
    WHERE id = p_task_id;
    RETURN 'escalated';
  END IF;

  -- GUARD 4: Capability gap with no other capable agent → escalate immediately
  IF p_failure_mode = 'capability_gap' AND v_task.requires_capability IS NULL THEN
    UPDATE task_queue SET
      status          = 'escalated',
      attempt_count   = v_new_count,
      failure_mode    = p_failure_mode,
      blocked_reason  = 'Capability gap with no capable agent identified. ' || COALESCE(p_reason, ''),
      failure_history = v_task.failure_history || v_history_entry,
      escalated_at    = now(),
      updated_at      = now()
    WHERE id = p_task_id;
    RETURN 'escalated';
  END IF;

  -- DEFAULT: mark failed, update tracking, signal caller to delegate
  UPDATE task_queue SET
    status          = 'failed',
    attempt_count   = v_new_count,
    failure_mode    = p_failure_mode,
    blocked_reason  = p_reason,
    failure_history = v_task.failure_history || v_history_entry,
    updated_at      = now()
  WHERE id = p_task_id;

  RETURN 'requeued';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.hybrid_recall(p_query_text text, p_query_embedding text DEFAULT NULL::text, p_match_threshold double precision DEFAULT 0.3, p_match_count integer DEFAULT 20, p_filter_type text DEFAULT NULL::text, p_agent_id text DEFAULT NULL::text, p_agent_scope text DEFAULT NULL::text, p_min_confidence double precision DEFAULT 0.0, p_memory_class text DEFAULT NULL::text, p_topic_hint text DEFAULT NULL::text, p_query_entities text[] DEFAULT NULL::text[])
 RETURNS TABLE(id uuid, type text, name text, description text, content text, tags text[], source text, conflict_flagged boolean, access_count integer, importance_score double precision, hybrid_score double precision, confidence double precision, staleness_candidate boolean, memory_class text, matched_entities text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_embedding  vector(768);
  result_ids   uuid[];
  v_topic      text := NULLIF(TRIM(COALESCE(p_topic_hint, '')), '');
  v_entities   text[];
  v_w          double precision[];
  v_wl_trgm    double precision;
  v_trgm_floor double precision;
  v_trgm_probe text;
  -- Migration 093: lane weights are data now, and IDF-conditioned when enabled.
  v_wl_vec     double precision;
  v_wl_bm25w   double precision;
  v_wl_bm25p   double precision;
  v_wl_topic   double precision;
  v_wl_entity  double precision;
  v_idf_on     boolean;
  v_idf_str    double precision;
  v_idf_pivot  double precision;
  v_idf        double precision;
  v_tilt       double precision := 0.0;
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;
  v_entities := COALESCE(p_query_entities, public.extract_entities(p_query_text));
  IF v_entities IS NOT NULL AND array_length(v_entities, 1) IS NULL THEN
    v_entities := NULL;
  END IF;

  -- Read the tuning row ONCE. Both scoring sites get the same v_w, so a concurrent
  -- UPDATE to recall_weights mid-sweep cannot score the selection site with one
  -- weight vector and the return site with another.
  SELECT ARRAY[rw.w_recency, rw.w_access, rw.w_novelty,
               rw.w_importance, rw.w_relevance, rw.w_recall_count],
         rw.w_lane_trgm, rw.trgm_floor,
         rw.w_lane_vec, rw.w_lane_bm25w, rw.w_lane_bm25p,
         rw.w_lane_topic, rw.w_lane_entity,
         rw.idf_adaptive_enabled, rw.idf_strength, rw.idf_pivot
    INTO v_w, v_wl_trgm, v_trgm_floor,
         v_wl_vec, v_wl_bm25w, v_wl_bm25p, v_wl_topic, v_wl_entity,
         v_idf_on, v_idf_str, v_idf_pivot
  FROM public.recall_weights rw WHERE rw.id;
  IF v_w IS NULL THEN
    v_w := ARRAY[0.25, 0.20, 0.15, 0.25, 0.15, 0.10];
    v_wl_trgm := 0.5;
    v_trgm_floor := 0.05;
  END IF;

  -- topic_hint is the caller's distilled intent — a far better trigram probe than
  -- a full question sentence, whose stopwords drown a three-word title.
  -- Defaults reproduce the migration 086 constants exactly, so a missing or
  -- partial recall_weights row degrades to the known-good static ranking.
  v_wl_vec    := COALESCE(v_wl_vec,    1.0);
  v_wl_bm25w  := COALESCE(v_wl_bm25w,  1.2);
  v_wl_bm25p  := COALESCE(v_wl_bm25p,  0.8);
  v_wl_topic  := COALESCE(v_wl_topic,  1.5);
  v_wl_entity := COALESCE(v_wl_entity, 1.3);

  -- vstash IDF conditioning (migration 093, arXiv 2604.15484). High-IDF
  -- queries (rare, technical tokens) push weight toward the lexical lanes;
  -- low-IDF queries push toward the dense lane. OFF by default, so the A/B
  -- control arm is bit-identical to the 086 ranking.
  -- Probe is the topic_hint when present: it is the caller's distilled intent,
  -- and a full question sentence drags mean IDF down with stopwords.
  -- RRF k stays 60 in BOTH arms -- 88 eval queries is under the ~200 threshold
  -- where tuning k is anything but noise-fitting.
  IF COALESCE(v_idf_on, false) THEN
    v_idf  := public.query_idf_norm(COALESCE(v_topic, p_query_text));
    v_tilt := COALESCE(v_idf_str, 0.5) * (v_idf - COALESCE(v_idf_pivot, 0.413));
    -- Clamp so no lane can invert or vanish however the pivot is tuned.
    v_tilt := GREATEST(-0.9, LEAST(0.9, v_tilt));
    v_wl_bm25w  := v_wl_bm25w  * (1.0 + v_tilt);
    v_wl_bm25p  := v_wl_bm25p  * (1.0 + v_tilt);
    v_wl_topic  := v_wl_topic  * (1.0 + v_tilt);
    v_wl_trgm   := v_wl_trgm   * (1.0 + v_tilt);
    v_wl_vec    := v_wl_vec    * (1.0 - v_tilt);
    -- entity lane deliberately NOT tilted: extract_entities() already emits
    -- only high-IDF surface forms, so scaling it by query IDF double-counts.
  END IF;

  v_trgm_probe := COALESCE(v_topic, p_query_text);

  WITH
  -- <LANES>
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC, m.id) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC, m.id) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC, m.id) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  -- Lexical-similarity lane. Ungated (see migration header): it used to switch
  -- itself off globally whenever EITHER BM25 lane returned a single row, which is
  -- every non-trivial query, so the lane that scores an exact title match 1.00
  -- almost never reached the fusion. Now it always runs and earns its rank.
  -- Probe = topic_hint when present (that is the caller's distilled intent), and
  -- the lane now scores the NAME (and name+description), not name||description||
  -- content. Two reasons. Signal: trigram similarity against a 2.4 KB average body
  -- dilutes an exact title match to noise, and body-text lexical matching is
  -- already what the two BM25 lanes do. Cost: the full-body expression measured
  -- 368 ms per pass over 874 rows, evaluated twice per site and at two sites --
  -- 1.5 s of the 1.5 s total. Name-only is ~9 ms and hits idx_memories_name_trgm.
  -- Nothing live is lost: the old body lane was gated off on every query where
  -- either BM25 lane returned a row, which is nearly all of them.
  -- Floor is tunable via recall_weights.trgm_floor.
  trgm_ranked AS (
    SELECT s.mem_id, ROW_NUMBER() OVER (ORDER BY s.sim DESC, s.mem_id) AS trgm_rank
    FROM (
      SELECT m.id AS mem_id, GREATEST(
          similarity(m.name, v_trgm_probe),
          strict_word_similarity(m.name, p_query_text),
          similarity(m.name || ' ' || COALESCE(m.description, ''), v_trgm_probe)
        ) AS sim
      FROM memories m
      WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ) s
    WHERE s.sim >= v_trgm_floor
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(v_wl_vec / (60.0 + v.vec_rank), 0.0)
       + COALESCE(v_wl_bm25w / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(v_wl_bm25p / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(v_wl_topic / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(v_wl_entity / (60.0 + e.entity_rank), 0.0)
       + COALESCE(v_wl_trgm / (60.0 + t.trgm_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  -- Relevance normalised WITHIN the candidate set, not against a magic constant.
  -- The old term was LEAST(rrf_score / 0.033, 1.0); max attainable rrf_score is
  -- 6.3/61 = 0.103, so any row hitting two lanes near rank 1 saturated at 1.0 and
  -- relevance stopped discriminating exactly where it mattered. Dividing by the
  -- per-query max makes it a true 0..1 spread on every query.
  -- Computed HERE, inside the CTE, and not as a window in the outer SELECT: the
  -- RETURN QUERY site filters on result_ids, so an outer window would normalise
  -- over a different population than the selection site and the two would drift.
  rrf_n AS (
    SELECT r.mem_id,
           COALESCE(r.rrf_score / NULLIF(MAX(r.rrf_score) OVER (), 0.0), 0.0) AS rrf_norm
    FROM rrf r
  )
  -- </LANES>
  SELECT ARRAY_AGG(sel.id ORDER BY sel.hybrid_score DESC, sel.id)
    INTO result_ids
  FROM (
    SELECT m.id,
    -- <AMAC>
    public.amac_score(
      COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()),
      m.memory_class,
      COALESCE(m.access_count, 0),
      m.amac_novelty_score,
      m.importance_score,
      rrf_n.rrf_norm,
      COALESCE(m.recall_count, 0),
      m.trust_tier,
      m.superseded_by,
      m.conflict_flagged,
      v_w
    )
    -- </AMAC>
      AS hybrid_score
    FROM rrf_n
    JOIN memories m ON m.id = rrf_n.mem_id
    WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND m.trust_tier IS DISTINCT FROM 'quarantined'
    ORDER BY hybrid_score DESC, m.id
    LIMIT p_match_count
  ) sel;

  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count = COALESCE(mem_upd.access_count, 0) + 1,
        recall_count = COALESCE(mem_upd.recall_count, 0) + 1,
        accessed_at = now(), last_accessed_at = now(), last_accessed = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- NOTE: the access/recall bump above has already fired, so the composite below
  -- is computed against bumped counters while the selection above saw pre-bump
  -- ones. That was true before this migration too and it only ever reorders rows
  -- WITHIN the already-chosen set (every returned row got the same +1), which is
  -- why it is left alone here rather than folded into an unrelated change.
  RETURN QUERY
  WITH
  -- <LANES>
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC, m.id) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC, m.id) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC, m.id) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  -- Lexical-similarity lane. Ungated (see migration header): it used to switch
  -- itself off globally whenever EITHER BM25 lane returned a single row, which is
  -- every non-trivial query, so the lane that scores an exact title match 1.00
  -- almost never reached the fusion. Now it always runs and earns its rank.
  -- Probe = topic_hint when present (that is the caller's distilled intent), and
  -- the lane now scores the NAME (and name+description), not name||description||
  -- content. Two reasons. Signal: trigram similarity against a 2.4 KB average body
  -- dilutes an exact title match to noise, and body-text lexical matching is
  -- already what the two BM25 lanes do. Cost: the full-body expression measured
  -- 368 ms per pass over 874 rows, evaluated twice per site and at two sites --
  -- 1.5 s of the 1.5 s total. Name-only is ~9 ms and hits idx_memories_name_trgm.
  -- Nothing live is lost: the old body lane was gated off on every query where
  -- either BM25 lane returned a row, which is nearly all of them.
  -- Floor is tunable via recall_weights.trgm_floor.
  trgm_ranked AS (
    SELECT s.mem_id, ROW_NUMBER() OVER (ORDER BY s.sim DESC, s.mem_id) AS trgm_rank
    FROM (
      SELECT m.id AS mem_id, GREATEST(
          similarity(m.name, v_trgm_probe),
          strict_word_similarity(m.name, p_query_text),
          similarity(m.name || ' ' || COALESCE(m.description, ''), v_trgm_probe)
        ) AS sim
      FROM memories m
      WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ) s
    WHERE s.sim >= v_trgm_floor
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(v_wl_vec / (60.0 + v.vec_rank), 0.0)
       + COALESCE(v_wl_bm25w / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(v_wl_bm25p / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(v_wl_topic / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(v_wl_entity / (60.0 + e.entity_rank), 0.0)
       + COALESCE(v_wl_trgm / (60.0 + t.trgm_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  -- Relevance normalised WITHIN the candidate set, not against a magic constant.
  -- The old term was LEAST(rrf_score / 0.033, 1.0); max attainable rrf_score is
  -- 6.3/61 = 0.103, so any row hitting two lanes near rank 1 saturated at 1.0 and
  -- relevance stopped discriminating exactly where it mattered. Dividing by the
  -- per-query max makes it a true 0..1 spread on every query.
  -- Computed HERE, inside the CTE, and not as a window in the outer SELECT: the
  -- RETURN QUERY site filters on result_ids, so an outer window would normalise
  -- over a different population than the selection site and the two would drift.
  rrf_n AS (
    SELECT r.mem_id,
           COALESCE(r.rrf_score / NULLIF(MAX(r.rrf_score) OVER (), 0.0), 0.0) AS rrf_norm
    FROM rrf r
  )
  -- </LANES>
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    -- <AMAC>
    public.amac_score(
      COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()),
      m.memory_class,
      COALESCE(m.access_count, 0),
      m.amac_novelty_score,
      m.importance_score,
      rrf_n.rrf_norm,
      COALESCE(m.recall_count, 0),
      m.trust_tier,
      m.superseded_by,
      m.conflict_flagged,
      v_w
    )
    -- </AMAC>
    AS hybrid_score,
    COALESCE(m.confidence, 0.8)::float,
    COALESCE(m.staleness_candidate, false),
    m.memory_class,
    CASE WHEN v_entities IS NOT NULL THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities)) ELSE ARRAY[]::text[] END AS matched_entities
  FROM rrf_n
  JOIN memories m ON m.id = rrf_n.mem_id
  WHERE m.is_active IS NOT FALSE AND m.id = ANY(result_ids)
    AND m.trust_tier IS DISTINCT FROM 'quarantined'
  ORDER BY hybrid_score DESC, m.id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.hybrid_search_memories(p_query_text text, p_query_embedding text DEFAULT NULL::text, p_match_threshold double precision DEFAULT 0.25, p_match_count integer DEFAULT 20, p_filter_type text DEFAULT NULL::text, p_agent_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, type text, name text, description text, content text, tags text[], source text, visibility text, agent_id text, importance_score double precision, access_count integer, rrf_score double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_embedding vector(768);
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY (m.embedding::vector) <=> v_embedding ASC
      ) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC
      ) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),    0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
      ) AS raw_rrf
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
  )
  SELECT
    m.id,
    m.type,
    m.name,
    m.description,
    m.content,
    m.tags,
    m.source,
    COALESCE(m.visibility, 'shared')::text   AS visibility,
    m.agent_id,
    COALESCE(m.importance_score, 0.5)::float AS importance_score,
    COALESCE(m.access_count,    0)::integer  AS access_count,
    (rrf.raw_rrf
      * COALESCE(m.importance_score, 0.5)
      / (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float))
    )::double precision                       AS rrf_score
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
    AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
  ORDER BY rrf_score DESC
  LIMIT p_match_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_stale_now(m memories)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time);
$function$
;

CREATE OR REPLACE FUNCTION public.lab_health_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ts', now(),
    'stale_agents', (SELECT coalesce(jsonb_agg(jsonb_build_object('agent',agent,'last',last_heartbeat,'breaker',breaker_tripped) ORDER BY agent),'[]'::jsonb)
        FROM agent_heartbeat
        WHERE breaker_tripped OR (status='active' AND last_heartbeat < now()-interval '30 minutes')),
    'failed_tasks', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',left(id::text,8),'title',left(title,50),'status',status) ORDER BY updated_at DESC),'[]'::jsonb)
        FROM task_queue
        WHERE status IN ('failed','escalated') AND coalesce(updated_at,created_at) > now()-interval '1 hour'),
    'stuck_tasks', (SELECT count(*) FROM task_queue
        WHERE status IN ('pending','claimed','in_progress_agent') AND created_at < now()-interval '2 hours'),
    'overdue_schedules', (SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'due',next_run_at,'last',last_status) ORDER BY next_run_at),'[]'::jsonb)
        FROM scheduled_activity
        WHERE enabled AND paused_at IS NULL AND next_run_at IS NOT NULL AND next_run_at < now()-interval '15 minutes')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.link_memories_to_skills(p_memory_ids uuid[], p_similarity_threshold double precision DEFAULT 0.75)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO skill_memory_links (skill_id, memory_id, similarity, updated_at)
  SELECT DISTINCT ON (s.id, m.id)
    s.id  AS skill_id,
    m.id  AS memory_id,
    (1.0 - (s.embedding::vector <=> m.embedding::vector))::double precision AS sim,
    now()
  FROM skills s
  CROSS JOIN memories m
  WHERE m.id = ANY(p_memory_ids)
    AND s.embedding IS NOT NULL
    AND m.embedding IS NOT NULL
    AND (1.0 - (s.embedding::vector <=> m.embedding::vector)) >= p_similarity_threshold
  ON CONFLICT (skill_id, memory_id) DO UPDATE
    SET similarity  = EXCLUDED.similarity,
        updated_at  = now()
  WHERE skill_memory_links.similarity < EXCLUDED.similarity;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.list_credentials(p_caller text DEFAULT 'unknown'::text)
 RETURNS TABLE(name text, type text, username text, host text, port integer, notes text, tags text[], projects text[], agents text[], last_accessed_at timestamp with time zone, last_accessed_by text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    INSERT INTO credential_access_log (credential_name, accessed_by, action, success)
    VALUES ('*', p_caller, 'list', true);

    RETURN QUERY
    SELECT c.name, c.type, c.username, c.host, c.port, c.notes,
           c.tags, c.projects, c.agents, c.last_accessed_at, c.last_accessed_by, c.updated_at
    FROM credentials c ORDER BY c.name;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_memory_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'INSERT' then
    insert into public.memory_log (memory_id, action, new_content, source)
    values (new.id, 'create', new.content, new.source);
    return new;
  elsif tg_op = 'UPDATE' then
    -- Only log if content actually changed
    if old.content IS DISTINCT FROM new.content then
      insert into public.memory_log (memory_id, action, old_content, new_content, source)
      values (new.id, 'update', old.content, new.content, new.source);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.memory_log (memory_id, action, old_content, source)
    values (old.id, 'delete', old.content, old.source);
    return old;
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_consistency_checked()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  checked_count integer;
BEGIN
  UPDATE memories m
  SET consistency_checked_at = now()
  WHERE COALESCE(m.is_active, true) IS NOT FALSE
    AND COALESCE(m.conflict_flagged, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM memory_conflicts c
      WHERE COALESCE(c.resolved, false) = false
        AND (c.memory_a_id = m.id OR c.memory_b_id = m.id)
    );

  GET DIAGNOSTICS checked_count = ROW_COUNT;
  RETURN checked_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.match_episodes(query_embedding extensions.vector, match_count integer DEFAULT 5, filter_agent text DEFAULT NULL::text, filter_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, agent text, task_id uuid, started_at timestamp with time zone, ended_at timestamp with time zone, status text, summary text, input_summary text, outcome text, learnings text, memories_consulted uuid[], similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT id, agent, task_id, started_at, ended_at, status, summary, input_summary,
    outcome, learnings, memories_consulted,
    1 - (embedding <=> query_embedding) AS similarity
  FROM agent_episodes
  WHERE embedding IS NOT NULL
    AND (filter_agent IS NULL OR agent = filter_agent)
    AND (filter_status IS NULL OR status = filter_status)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$function$
;

CREATE OR REPLACE FUNCTION public.match_memories(query_embedding extensions.vector, match_threshold double precision DEFAULT 0.5, match_count integer DEFAULT 10)
 RETURNS TABLE(id uuid, type text, name text, description text, content text, tags text[], source text, similarity double precision, decay_score double precision, rank double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_ts timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.type,
    m.name,
    m.description,
    m.content,
    m.tags,
    m.source,
    (1 - (m.embedding <=> query_embedding))::float AS similarity,
    -- Decay: recency factor (half-life ~30 days) * use boost
    (
      EXP(-0.023 * EXTRACT(EPOCH FROM (now_ts - COALESCE(m.accessed_at, m.created_at))) / 86400.0)
      * (1.0 + LN(1.0 + COALESCE(m.access_count, 0)::float) * 0.1)
    )::float AS decay_score,
    -- Combined rank: 80% semantic similarity + 20% decay
    (
      0.8 * (1 - (m.embedding <=> query_embedding))
      + 0.2 * EXP(-0.023 * EXTRACT(EPOCH FROM (now_ts - COALESCE(m.accessed_at, m.created_at))) / 86400.0)
    )::float AS rank
  FROM memories m
  WHERE
    m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> query_embedding)) > match_threshold
  ORDER BY rank DESC
  LIMIT match_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.match_memories(query_embedding extensions.vector, match_count integer DEFAULT 5, filter_type text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, type text, name text, description text, content text, tags text[], source text, updated_at timestamp with time zone, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, type, name, description, content, tags, source, updated_at,
    1 - (embedding <=> query_embedding) AS similarity
  FROM memories
  WHERE embedding IS NOT NULL
    AND (filter_type IS NULL OR type = filter_type)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$function$
;

CREATE OR REPLACE FUNCTION public.match_skills(query_embedding extensions.vector, match_count integer DEFAULT 5)
 RETURNS TABLE(id uuid, name text, title text, description text, content text, triggers text[], platforms text[], use_count integer, updated_at timestamp with time zone, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, name, title, description, content, triggers, platforms, use_count, updated_at,
    1 - (embedding <=> query_embedding) AS similarity
  FROM skills
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$function$
;

CREATE OR REPLACE FUNCTION public.memories_extract_entities_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.entities := public.extract_entities(
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.description, '') || ' ' ||
    COALESCE(NEW.content, '')
  );
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.memory_health_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'total',           (SELECT count(*) FROM memories),
    'active',          (SELECT count(*) FROM memories WHERE COALESCE(is_active,true) IS NOT FALSE),
    'retired',         (SELECT count(*) FROM memories WHERE is_active IS FALSE),
    'hot',             (SELECT count(*) FROM memories WHERE memory_tier='hot'  AND COALESCE(is_active,true) IS NOT FALSE),
    'warm',            (SELECT count(*) FROM memories WHERE memory_tier='warm' AND COALESCE(is_active,true) IS NOT FALSE),
    'cold',            (SELECT count(*) FROM memories WHERE memory_tier='cold' AND COALESCE(is_active,true) IS NOT FALSE),
    'pinned',          (SELECT count(*) FROM memories WHERE lifecycle_pinned),
    'never_accessed',  (SELECT count(*) FROM memories WHERE COALESCE(access_count,0)=0 AND COALESCE(is_active,true) IS NOT FALSE),
    'queue_depth',     (SELECT count(*) FROM stale_memories_review_queue),
    'queue_head_age',  (SELECT EXTRACT(DAY FROM now()-min(created_at))::int FROM stale_memories_review_queue),
    'retire_eligible', (SELECT count(*) FROM memory_retirement_candidates WHERE NOT in_duplicate_cluster),
    'retire_held_dup', (SELECT count(*) FROM memory_retirement_candidates WHERE in_duplicate_cluster),
    'dup_rows',        (SELECT count(*) FROM (
                          SELECT id_a AS id FROM memory_duplicate_pairs
                          UNION SELECT id_b FROM memory_duplicate_pairs) d),
    'conflicts_open',  (SELECT count(*) FROM memory_conflicts WHERE COALESCE(resolved,false)=false),
    'autoretire',      (SELECT value FROM memory_lifecycle_settings WHERE key='autoretire_enabled'),
    'writers',         (SELECT COALESCE(jsonb_agg(w), '[]'::jsonb) FROM (
                          SELECT COALESCE(writer_agent,'(unknown)') AS agent, count(*) AS n
                          FROM memories WHERE created_at > now()-interval '7 days'
                          GROUP BY 1 ORDER BY 2 DESC) w),
    'eval',            (SELECT to_jsonb(e) FROM (
                          SELECT tag, recall_at_5, mrr, created_at AS "when"
                          FROM eval_runs ORDER BY created_at DESC LIMIT 1) e)
  )
$function$
;

CREATE OR REPLACE FUNCTION public.memory_is_log_series(p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_name IS NULL THEN false ELSE (
    WITH raw AS (
      SELECT p_name AS n
      UNION ALL
      SELECT regexp_replace(p_name, '^(semantic|episodic|ref|weekly-ref|summary):\s*', '', 'i')
    ),
    s AS (
      SELECT trim(both '_' from
               regexp_replace(
                 regexp_replace(lower(n), '[''—–\-]', '', 'g'),
                 '[^a-z0-9]+', '_', 'g')) AS slug
      FROM raw
    )
    SELECT bool_or(
           slug ~ '^ai_memory_research_\d'
        OR slug ~ '^daily_selfimprovement_research_\d'
        OR slug ~ '^ai_research_20\d'
        OR slug ~ '^(research|daily).*(triage|review|closeout|synthesis)'
        OR slug ~ '^dailyaimemoryresearchtriage'
        OR slug ~ '^dreaming(_summary)?_'
        OR slug ~ '^weeklyref_'
        OR slug ~ 'tech_breakthrough'
        OR slug ~ '^constitutionaudit'
        OR slug ~ '^weeklyrlsaudit'
    )
    FROM s
  ) END;
$function$
;

CREATE OR REPLACE FUNCTION public.memory_is_stale(p_type text, p_verified_at timestamp with time zone, p_created_at timestamp with time zone, p_expires_at timestamp with time zone, p_is_point_in_time boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- An immutable record makes no standing claim, so there is nothing to re-verify.
  -- Everything else delegates to the 4-arg rule -- one definition, per migration 085.
  SELECT CASE
    WHEN COALESCE(p_is_point_in_time, false) THEN false
    ELSE public.memory_is_stale(p_type, p_verified_at, p_created_at, p_expires_at)
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.memory_is_stale(p_type text, p_verified_at timestamp with time zone, p_created_at timestamp with time zone, p_expires_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_expires_at IS NOT NULL AND p_expires_at <= now()
      THEN COALESCE(p_verified_at, '-infinity'::timestamptz) < p_expires_at
    WHEN p_expires_at IS NOT NULL
      THEN false
    ELSE
      p_type IN ('project', 'reference')
      AND COALESCE(p_verified_at, p_created_at) < now() - interval '14 days'
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_memory_into(primary_id uuid, secondary_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Redirect memory_links from secondary → primary (skip if link already exists to avoid dupe)
  UPDATE memory_links
  SET source_id = primary_id
  WHERE source_id = secondary_id
    AND target_id != primary_id
    AND NOT EXISTS (
      SELECT 1 FROM memory_links
      WHERE source_id = primary_id AND target_id = memory_links.target_id AND relationship = memory_links.relationship
    );

  UPDATE memory_links
  SET target_id = primary_id
  WHERE target_id = secondary_id
    AND source_id != primary_id
    AND NOT EXISTS (
      SELECT 1 FROM memory_links
      WHERE target_id = primary_id AND source_id = memory_links.source_id AND relationship = memory_links.relationship
    );

  -- Remove any remaining links to/from secondary (duplicates or self-loops)
  DELETE FROM memory_links WHERE source_id = secondary_id OR target_id = secondary_id;
  DELETE FROM memory_links WHERE source_id = target_id;

  -- Remove conflicts involving secondary
  DELETE FROM memory_conflicts
  WHERE memory_a_id = secondary_id OR memory_b_id = secondary_id;

  -- Delete secondary
  DELETE FROM memories WHERE id = secondary_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_decayed_memories(min_age_days integer DEFAULT 30, min_amac_threshold double precision DEFAULT 0.20)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM memories
  WHERE
    updated_at < now() - (min_age_days || ' days')::interval
    AND (
      (
        0.25 * EXP(-0.1 * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(last_accessed_at, created_at, updated_at))) / 86400.0,
          0.0))
      + 0.20 * LEAST(LN(1.0 + COALESCE(access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(amac_novelty_score, 0.5)
      + 0.25 * COALESCE(importance_score, 0.5)
      ) / 0.85
    ) < min_amac_threshold;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.query_idf_norm(p_text text)
 RETURNS double precision
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH n AS (
    SELECT GREATEST(count(*), 1)::double precision AS total
    FROM public.memories WHERE is_active IS NOT FALSE
  ),
  terms AS (
    SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', COALESCE(p_text, '')))) AS w
  ),
  scored AS (
    SELECT ln((n.total + 1.0) / (COALESCE(d.ndoc, 0) + 1.0)) / ln(n.total + 1.0) AS idf
    FROM terms t CROSS JOIN n
    LEFT JOIN public.lexeme_doc_freq d ON d.lexeme = t.w
  )
  -- No terms (empty query, or all stopwords) -> 0.5 = neutral, no tilt at all.
  SELECT COALESCE(avg(idf), 0.5) FROM scored;
$function$
;

CREATE OR REPLACE FUNCTION public.queue_blocked_task(p_parent_id uuid, p_source_agent text, p_target_agent text, p_title text, p_description text, p_context jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT NULL::integer, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent   task_queue%ROWTYPE;
  v_new_id   UUID;
  v_priority INTEGER;
BEGIN
  SELECT * INTO v_parent FROM task_queue WHERE id = p_parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent task % not found', p_parent_id;
  END IF;

  -- Inherit parent priority if not overridden; cap at 1 (urgent) since it's a blocked delegation
  v_priority := COALESCE(p_priority, LEAST(v_parent.priority, 1));

  INSERT INTO task_queue (
    title, description, context, priority, status,
    source, target, tags,
    parent_task_id, requires_capability,
    expires_at, created_at, updated_at
  ) VALUES (
    p_title,
    p_description,
    p_context || jsonb_build_object(
      'delegated_from', p_parent_id,
      'delegated_by',   p_source_agent,
      'parent_title',   v_parent.title,
      'parent_failure', v_parent.failure_mode
    ),
    v_priority,
    'pending',
    p_source_agent,
    p_target_agent,
    COALESCE(v_parent.tags, '{}') || ARRAY['delegated', 'failure-recovery'],
    p_parent_id,
    v_parent.requires_capability,
    p_expires_at,
    now(),
    now()
  )
  RETURNING id INTO v_new_id;

  -- Mark parent as delegated
  UPDATE task_queue SET
    status     = 'delegated',
    updated_at = now()
  WHERE id = p_parent_id;

  RETURN v_new_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recall_scoring_sites_consistent()
 RETURNS TABLE(block text, sites integer, identical boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_src   text;
  v_name  text;
  v_parts text[];
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';

  FOREACH v_name IN ARRAY ARRAY['LANES', 'AMAC'] LOOP
    -- Split on the literal markers rather than a lazy regex. Postgres POSIX AREs
    -- take their greediness from the FIRST quantifier in the pattern, so a leading
    -- \s* makes even a (.*?) behave greedily and the two blocks collapse into one
    -- match. string_to_array has no such surprise.
    SELECT ARRAY(
      SELECT btrim(regexp_replace(split_part(u.chunk, '-- </' || v_name || '>', 1), '\s+', ' ', 'g'))
      FROM unnest(string_to_array(v_src, '-- <' || v_name || '>')) WITH ORDINALITY AS u(chunk, ord)
      WHERE u.ord > 1
    ) INTO v_parts;
    block     := v_name;
    sites     := COALESCE(array_length(v_parts, 1), 0);
    identical := sites >= 2
                 AND (SELECT count(DISTINCT p) FROM unnest(v_parts) p) = 1;
    RETURN NEXT;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_recurring_run_result(p_task_id uuid, p_result text, p_status text DEFAULT 'completed'::text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  last_idx int;
  cur_runs jsonb;
BEGIN
  SELECT runs, GREATEST(jsonb_array_length(runs) - 1, 0)
    INTO cur_runs, last_idx
    FROM public.task_queue
    WHERE id = p_task_id AND recurring = true;

  IF cur_runs IS NULL THEN
    RAISE EXCEPTION 'task % is not recurring or not found', p_task_id;
  END IF;

  UPDATE public.task_queue
  SET
    status = p_status,
    result = p_result,
    runs = jsonb_set(
      runs,
      ARRAY[last_idx::text],
      (runs->last_idx)
        || jsonb_build_object(
             'result',       p_result,
             'status',       p_status,
             'completed_at', to_jsonb(now()),
             'notes',        to_jsonb(p_notes)
           ),
      false
    )
  WHERE id = p_task_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_scheduled_run(p_name text, p_status text, p_result_summary text DEFAULT NULL::text, p_run_at timestamp with time zone DEFAULT now(), p_duration_sec numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id      UUID;
  v_run     JSONB;
  v_cutoff  TIMESTAMPTZ := now() - INTERVAL '7 days';
  v_kept    JSONB;
BEGIN
  v_run := jsonb_build_object(
    'run_at',          p_run_at,
    'status',          p_status,
    'result_summary',  p_result_summary,
    'duration_sec',    p_duration_sec,
    'notes',           p_notes
  );

  -- Filter existing runs to last 7 days, then append the new one.
  WITH src AS (
    SELECT runs FROM public.scheduled_activity WHERE name = p_name
  )
  SELECT COALESCE(
    (SELECT jsonb_agg(elem ORDER BY (elem->>'run_at')::timestamptz)
     FROM src, jsonb_array_elements(runs) elem
     WHERE (elem->>'run_at')::timestamptz >= v_cutoff),
    '[]'::jsonb
  )
  INTO v_kept;

  UPDATE public.scheduled_activity
     SET last_run_at         = p_run_at,
         last_status         = p_status,
         last_result_summary = p_result_summary,
         run_count           = run_count + 1,
         runs                = v_kept || v_run
   WHERE name = p_name
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'scheduled_activity % not found', p_name;
  END IF;

  INSERT INTO public.scheduled_activity_audit
    (scheduled_activity_id, scheduled_activity_name, action, actor, after, notes)
  VALUES
    (v_id, p_name, 'run_recorded', 'native', v_run, p_notes);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_skill_outcome(p_skill_name text, p_success boolean, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_found boolean;
BEGIN
  IF p_skill_name IS NULL OR btrim(p_skill_name) = '' OR p_success IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.skills
     SET success_count = COALESCE(success_count, 0) + (CASE WHEN p_success THEN 1 ELSE 0 END),
         fail_count    = COALESCE(fail_count, 0)    + (CASE WHEN p_success THEN 0 ELSE 1 END),
         last_outcome  = left(
                           COALESCE(
                             NULLIF(btrim(p_note), ''),
                             CASE WHEN p_success THEN 'success' ELSE 'failure' END
                           ), 500),
         last_used_at  = now(),
         updated_at    = now()
   WHERE name = p_skill_name;

  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_lexeme_doc_freq()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer;
BEGIN
  -- ts_stat is a full scan; at ~925 rows that is milliseconds, and this runs on
  -- a timer, never on the recall path.
  DELETE FROM public.lexeme_doc_freq;
  INSERT INTO public.lexeme_doc_freq (lexeme, ndoc)
  SELECT word, ndoc
  FROM ts_stat('SELECT search_vec FROM public.memories WHERE is_active IS NOT FALSE')
  ON CONFLICT (lexeme) DO UPDATE SET ndoc = EXCLUDED.ndoc;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_memory_duplicate_pairs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  REFRESH MATERIALIZED VIEW public.memory_duplicate_pairs;
  SELECT count(*) INTO n FROM public.memory_duplicate_pairs;
  RETURN n;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_conflict(p_conflict_id uuid, p_resolved_by text, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH closed AS (
    UPDATE memory_conflicts SET
        resolved = true,
        resolved_at = now(),
        resolved_by = p_resolved_by,
        resolution_notes = p_notes
    WHERE id = p_conflict_id
    RETURNING memory_a_id, memory_b_id
  ),
  touched AS (
    SELECT memory_a_id AS mid FROM closed
    UNION
    SELECT memory_b_id FROM closed
  )
  UPDATE memories m SET conflict_flagged = false
  WHERE m.id IN (SELECT mid FROM touched WHERE mid IS NOT NULL)
    AND COALESCE(m.conflict_flagged, false)
    -- c.id <> p_conflict_id is load-bearing: a data-modifying CTE's writes are NOT
    -- visible to the rest of the same statement, so the row `closed` just resolved
    -- still reads as unresolved here and would veto every clear.
    AND NOT EXISTS (
      SELECT 1 FROM memory_conflicts c
      WHERE c.id <> p_conflict_id
        AND COALESCE(c.resolved, false) = false
        AND (c.memory_a_id = m.id OR c.memory_b_id = m.id));
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_conflict_auto(p_conflict_id uuid, p_actor text DEFAULT 'conflict-sweep'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c            RECORD;
  a            RECORD;
  b            RECORD;
  v_dead       uuid;
  v_live       uuid;
  v_head       uuid;
  v_winner     uuid;
  v_loser      uuid;
  v_repointed  integer := 0;
  v_deweighted integer := 0;
  v_notes      text;
BEGIN
  SELECT * INTO c FROM memory_conflicts WHERE id = p_conflict_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'conflict not found');
  END IF;
  IF COALESCE(c.resolved, false) THEN
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'already resolved');
  END IF;

  SELECT id, version, updated_at, created_at, superseded_by, expires_at, is_active
    INTO a FROM memories WHERE id = c.memory_a_id;
  SELECT id, version, updated_at, created_at, superseded_by, expires_at, is_active
    INTO b FROM memories WHERE id = c.memory_b_id;

  -- A conflict whose sides no longer both exist is self-resolving.
  IF a.id IS NULL OR b.id IS NULL THEN
    PERFORM public.resolve_conflict(p_conflict_id, p_actor,
      'auto: one or both sides deleted; conflict is moot');
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_moot');
  END IF;

  -- ═══ CASE A: stale propagation ═════════════════════════════════════════════
  -- NOT a rival-value conflict. One side is dead (superseded or expired), the
  -- other is alive and still linked to it. The deterministic repair is to move
  -- the citation forward to the head of the chain, then de-weight the stale
  -- edge so spreading activation stops carrying the retired fact — WITHOUT
  -- deleting it, so the historical citation stays auditable (TOKI audit row).
  IF c.conflict_type = 'stale' THEN
    IF a.superseded_by IS NOT NULL
       OR COALESCE(a.expires_at, 'infinity'::timestamptz) <= now()
       OR a.is_active IS FALSE THEN
      v_dead := a.id; v_live := b.id;
    ELSIF b.superseded_by IS NOT NULL
       OR COALESCE(b.expires_at, 'infinity'::timestamptz) <= now()
       OR b.is_active IS FALSE THEN
      v_dead := b.id; v_live := a.id;
    ELSE
      -- Neither side is dead any more (the supersession was reverted, or the
      -- expiry extended). The detection no longer holds; close it as stale-detection.
      PERFORM public.resolve_conflict(p_conflict_id, p_actor,
        'auto: neither side is superseded/expired any more; stale flag no longer holds');
      RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_no_longer_stale');
    END IF;

    v_head := public.supersession_head(v_dead);
    IF v_head = v_dead THEN
      v_head := NULL;  -- expired-with-no-successor: nothing to re-point to
    END IF;

    -- Re-point: mirror every edge between live and dead onto live<->head.
    IF v_head IS NOT NULL AND v_head <> v_live THEN
      INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
      SELECT CASE WHEN l.source_id = v_dead THEN v_head ELSE l.source_id END,
             CASE WHEN l.target_id = v_dead THEN v_head ELSE l.target_id END,
             l.relationship,
             COALESCE(l.link_type, 'semantic'),
             COALESCE(l.strength, 0.5)
      FROM memory_links l
      WHERE (l.source_id = v_live AND l.target_id = v_dead)
         OR (l.source_id = v_dead AND l.target_id = v_live)
      ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
      GET DIAGNOSTICS v_repointed = ROW_COUNT;
    END IF;

    -- De-weight, never delete. 0.05 keeps the edge queryable as provenance while
    -- making it negligible to spreading-activation rerank (migration 047).
    UPDATE memory_links l
    SET strength = 0.05
    WHERE ((l.source_id = v_live AND l.target_id = v_dead)
        OR (l.source_id = v_dead AND l.target_id = v_live))
      AND l.relationship <> 'supersedes'   -- the supersession edge itself stays authoritative
      AND COALESCE(l.strength, 0.5) > 0.05;
    GET DIAGNOSTICS v_deweighted = ROW_COUNT;

    v_notes := format(
      'auto(stale): dead=%s head=%s; re-pointed %s link(s) to head, de-weighted %s stale link(s) to 0.05. No supersedes edge invented — these are citation links, not rival values.',
      v_dead, COALESCE(v_head::text, 'none'), v_repointed, v_deweighted);
    PERFORM public.resolve_conflict(p_conflict_id, p_actor, v_notes);

    RETURN jsonb_build_object(
      'conflict_id', p_conflict_id, 'action', 'stale_repaired',
      'dead', v_dead, 'live', v_live, 'head', v_head,
      'repointed', v_repointed, 'deweighted', v_deweighted);
  END IF;

  -- ═══ CASE B: genuine value conflict ════════════════════════════════════════
  -- contradiction / duplicate / near_duplicate / concurrent_write /
  -- temporal_supersession / overlap. Winner = max(version, content_timestamp),
  -- with created_at then id as total-order tiebreaks so the function is a pure
  -- deterministic fold — same inputs, same winner, on every replay. This is the
  -- max(serial) recipe from arXiv:2606.01435 with the LLM off the write path.
  -- content_timestamp, NOT updated_at — see the 1b comment block.
  IF (a.version, public.content_timestamp(a.id), a.created_at, a.id)
   > (b.version, public.content_timestamp(b.id), b.created_at, b.id) THEN
    v_winner := a.id; v_loser := b.id;
  ELSE
    v_winner := b.id; v_loser := a.id;
  END IF;

  -- Already resolved in the graph? Close the audit row, don't re-supersede.
  IF (SELECT superseded_by FROM memories WHERE id = v_loser) IS NOT NULL THEN
    PERFORM public.resolve_conflict(p_conflict_id, p_actor,
      format('auto(%s): loser %s already superseded; conflict row closed', c.conflict_type, v_loser));
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_already_superseded',
                              'winner', v_winner, 'loser', v_loser);
  END IF;
  IF (SELECT superseded_by FROM memories WHERE id = v_winner) IS NOT NULL THEN
    -- The side we'd keep is itself retired — the pair is stale relative to a
    -- third row. Don't guess; leave it for a human/agent.
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'winner is itself superseded; needs manual review');
  END IF;

  -- supersede_memory() is the existing TOKI-compliant operator: it sets
  -- superseded_by + is_active=false (PRESERVES the row — no delete), rewires
  -- inbound links onto the winner, writes the loser->winner 'supersedes'
  -- relationship edge, and appends to memory_log. Do not reimplement it here.
  PERFORM public.supersede_memory(v_loser, v_winner,
    format('deterministic conflict resolution (migration 063): %s, winner by (version, content_timestamp)', c.conflict_type));

  PERFORM public.resolve_conflict(p_conflict_id, p_actor,
    format('auto(%s): winner=%s loser=%s by max(version, content_timestamp); loser preserved as audit row',
           c.conflict_type, v_winner, v_loser));

  RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'superseded',
                            'winner', v_winner, 'loser', v_loser);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.retire_cold_memories(p_limit integer DEFAULT 25, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(id uuid, name text, standing_value double precision, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT value INTO v_enabled FROM public.memory_lifecycle_settings WHERE key = 'autoretire_enabled';

  IF NOT p_dry_run AND NOT COALESCE(v_enabled, false) THEN
    RAISE NOTICE 'retire_cold_memories: autoretire_enabled is false - forcing dry run.';
    p_dry_run := true;
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT c.id, c.name, c.standing_value
    FROM public.memory_retirement_candidates c
    WHERE c.in_duplicate_cluster = false
    ORDER BY c.standing_value ASC
    LIMIT p_limit
  ), done AS (
    UPDATE memories m
    SET is_active = false, retired_at = now(),
        retire_reason = 'lifecycle: cold tier, never accessed, aged >90d (migration 065)'
    FROM picked p
    WHERE m.id = p.id AND NOT p_dry_run
    RETURNING m.id
  )
  SELECT p.id, p.name, p.standing_value,
         CASE WHEN p_dry_run THEN 'DRY RUN: would retire' ELSE 'RETIRED (soft)' END
  FROM picked p;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.retire_nightly_consolidation_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.review_forget_mutation(p_audit_id uuid, p_verdict text, p_reasoning text DEFAULT NULL::text, p_confidence double precision DEFAULT NULL::double precision, p_reviewer text DEFAULT 'nemotron-120b'::text, p_failure_mode text DEFAULT NULL::text)
 RETURNS jsonb
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
$function$
;

CREATE OR REPLACE FUNCTION public.scan_memory_contradictions(p_sim_floor double precision DEFAULT 0.88, p_sim_ceiling double precision DEFAULT 0.92, p_high_conf_sim double precision DEFAULT 0.90, p_min_age_gap_days integer DEFAULT 7, p_max_new integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_contradictions integer := 0;
  v_high           integer := 0;
  v_flagged        integer := 0;
  v_stale          integer := 0;
begin
  -- 1. Contradiction candidates (top-N by similarity per run)
  with lg as (
    select memory_id, max(created_at) as last_change
    from memory_log
    where action in ('create', 'update')
    group by memory_id
  ),
  active as (
    select m.id, m.name, m.writer_agent, m.embedding, m.trust_tier,
           lower(regexp_replace(m.name, '[0-9]', '', 'g')) as series_key,
           greatest(m.created_at, coalesce(lg.last_change, m.created_at)) as content_ts
    from memories m
    left join lg on lg.memory_id = m.id
    where m.superseded_by is null
      and m.embedding is not null
      and coalesce(m.expires_at, 'infinity'::timestamptz) > now()
      and m.name !~ '(\d{4}-\d{2}-\d{2}|(19|20)\d{6})'  -- dated journal entries can't contradict
  ),
  candidates as (
    select
      least(a.id, b.id)    as a_id,
      greatest(a.id, b.id) as b_id,
      1 - (a.embedding <=> b.embedding) as sim,
      case when a.content_ts <= b.content_ts then a.id           else b.id           end as older_id,
      case when a.content_ts <= b.content_ts then a.name         else b.name         end as older_name,
      case when a.content_ts <= b.content_ts then a.writer_agent else b.writer_agent end as older_agent,
      case when a.content_ts <= b.content_ts then a.content_ts   else b.content_ts   end as older_ts,
      case when a.content_ts <= b.content_ts then b.name         else a.name         end as newer_name,
      case when a.content_ts <= b.content_ts then b.writer_agent else a.writer_agent end as newer_agent,
      case when a.content_ts <= b.content_ts then b.content_ts   else a.content_ts   end as newer_ts,
      (a.trust_tier = 'high' and b.trust_tier = 'high') as both_high_trust,
      a.trust_tier as tier_a,
      b.trust_tier as tier_b
    from active a
    join active b on a.id < b.id
    where a.writer_agent is not null
      and b.writer_agent is not null
      -- NOTE: the `a.writer_agent <> b.writer_agent` requirement was removed in
      -- migration 082 — it made this predicate unsatisfiable (see header).
      and not (a.name <> b.name and a.series_key = b.series_key)
      and 1 - (a.embedding <=> b.embedding) >= p_sim_floor
      and 1 - (a.embedding <=> b.embedding) <  p_sim_ceiling
      and abs(extract(epoch from a.content_ts - b.content_ts)) > p_min_age_gap_days * 86400
      and not exists (
        select 1 from memory_conflicts mc
        where mc.memory_a_id = least(a.id, b.id)
          and mc.memory_b_id = greatest(a.id, b.id)
      )
    order by 1 - (a.embedding <=> b.embedding) desc
    limit p_max_new
  ),
  ins as (
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by, resolution_heuristic)
    select
      c.a_id, c.b_id, 'contradiction',
      case when c.sim >= p_high_conf_sim and c.both_high_trust
           then 'HIGH-CONFIDENCE: ' else '' end
        || format('Divergence (sim %s): older "%s" [%s, %s] vs newer "%s" [%s, %s]',
             round(c.sim::numeric, 3),
             c.older_name, c.older_agent, to_char(c.older_ts, 'YYYY-MM-DD'),
             c.newer_name, c.newer_agent, to_char(c.newer_ts, 'YYYY-MM-DD')),
      'contradiction-scan',
      public.trust_tier_to_heuristic(c.tier_a, c.tier_b)
    from candidates c
    on conflict (memory_a_id, memory_b_id) do nothing
    returning description
  ),
  flag as (
    update memories m
       set conflict_flagged = true
      from candidates c
     where m.id = c.older_id
       and c.sim >= p_high_conf_sim
       and c.both_high_trust
       and m.conflict_flagged = false
    returning m.id
  )
  select
    (select count(*) from ins),
    (select count(*) from ins where description like 'HIGH-CONFIDENCE%'),
    (select count(*) from flag)
    into v_contradictions, v_high, v_flagged;

  -- 2. Stale propagation through the link graph
  with lg as (
    select memory_id, max(created_at) as last_change
    from memory_log
    where action in ('create', 'update')
    group by memory_id
  ),
  edges as (
    select source_id as live_id, target_id as dead_id from memory_links
    union
    select target_id, source_id from memory_links
  ),
  ins as (
    insert into memory_conflicts (memory_a_id, memory_b_id, conflict_type, description, detected_by, resolution_heuristic)
    select
      least(live.id, dead.id),
      greatest(live.id, dead.id),
      'stale',
      format('Stale propagation: active "%s" [%s] links to %s "%s" and has no content change since (%s < %s)',
        live.name, live.writer_agent,
        case when dead.superseded_by is not null then 'superseded' else 'expired' end,
        dead.name,
        to_char(greatest(live.created_at, coalesce(lg.last_change, live.created_at)), 'YYYY-MM-DD'),
        to_char(coalesce(succ.created_at, dead.expires_at), 'YYYY-MM-DD')),
      'contradiction-scan',
      public.trust_tier_to_heuristic(live.trust_tier, dead.trust_tier)
    from edges e
    join memories live on live.id = e.live_id
    join memories dead on dead.id = e.dead_id
    left join memories succ on succ.id = dead.superseded_by
    left join lg on lg.memory_id = live.id
    where live.superseded_by is null
      and coalesce(live.expires_at, 'infinity'::timestamptz) > now()
      and (dead.superseded_by is not null
           or coalesce(dead.expires_at, 'infinity'::timestamptz) <= now())
      and greatest(live.created_at, coalesce(lg.last_change, live.created_at))
          < coalesce(succ.created_at, dead.expires_at)
    on conflict (memory_a_id, memory_b_id) do nothing
    returning 1
  )
  select count(*) into v_stale from ins;

  return jsonb_build_object(
    'new_contradictions', v_contradictions,
    'new_high_confidence', v_high,
    'new_stale', v_stale,
    'newly_flagged_memories', v_flagged,
    'open_conflicts_total', (select count(*) from memory_conflicts where resolved = false)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.scan_memory_for_injection()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_combined text;
  v_threat   text;
  v_soft     text;
begin
  -- Provenance-derived tier first; the soft-signal block below may cap it.
  new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);

  if tg_op = 'UPDATE'
     and old.content     is not distinct from new.content
     and old.name        is not distinct from new.name
     and old.description is not distinct from new.description
  then
    return new;
  end if;

  v_combined := coalesce(new.name, '') || E'\n'
             || coalesce(new.description, '') || E'\n'
             || coalesce(new.content, '');

  -- HARD BLOCK: unchanged from migration 041. A hit rejects the write.
  v_threat := case
    when v_combined ~* 'ignore\s+(previous|all|above|prior)\s+instructions'                              then 'prompt_injection'
    when v_combined ~* 'you\s+are\s+now\s+'                                                              then 'role_hijack'
    when v_combined ~* 'do\s+not\s+tell\s+the\s+user'                                                    then 'deception_hide'
    when v_combined ~* 'system\s+prompt\s+override'                                                      then 'sys_prompt_override'
    when v_combined ~* 'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)'                    then 'disregard_rules'
    when v_combined ~* 'act\s+as\s+(if|though)\s+you\s+(have\s+no|don''?t\s+have)\s+(restrictions|limits|rules)' then 'bypass_restrictions'
    when v_combined ~* 'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)'                 then 'exfil_curl'
    when v_combined ~* 'wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)'                 then 'exfil_wget'
    when v_combined ~* 'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)'               then 'read_secrets'
    when v_combined ~* 'authorized_keys'                                                                 then 'ssh_backdoor'
    when v_combined ~* 'pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|another)'                  then 'persona_hijack'
    when v_combined ~* 'your\s+(new\s+)?(instructions?|rules?|directives?)\s+are'                        then 'instruction_override'
    when v_combined ~  E'[​-‍⁠﻿‪-‮]'                                       then 'invisible_unicode'
    else null
  end;

  if v_threat is not null then
    raise exception 'memory_governance_block: % matched in memory "%"', v_threat, coalesce(new.name, '<unnamed>')
      using errcode = 'check_violation', hint = 'Content matched a known prompt-injection / exfil pattern. Edit before re-submitting.';
  end if;

  -- SOFT SIGNAL: store, but cap trust at 'quarantined' (weight 0.40).
  -- Evaluated only after the hard block, so a severe hit still rejects outright.
  v_soft := case
    when v_combined ~* '(this|the following)\s+(memory|fact|instruction)\s+(is|should be)\s+(treated as\s+)?(authoritative|trusted|verified|highest)'
                                                                        then 'self_asserted_authority'
    when v_combined ~* 'override\s+(all\s+)?(other|previous|existing)\s+(memor|instruction|rule)'
                                                                        then 'self_asserted_precedence'
    when v_combined ~* 'data:[a-z]+/[a-z]+;base64,'                     then 'embedded_data_uri'
    when v_combined ~* '<!--[^>]*(instruction|prompt|ignore|system)[^>]*-->' then 'hidden_html_directive'
    when v_combined ~* '\b(eval|exec)\s*\(\s*(requests\.|urllib|fetch\()' then 'remote_code_exec'
    else null
  end;

  if v_soft is not null then
    new.trust_tier := 'quarantined';
    raise notice 'memory_governance_quarantine: % in memory "%" - stored at trust_tier=quarantined',
      v_soft, coalesce(new.name, '<unnamed>');
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_point_in_time_from_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_point_in_time IS NOT TRUE AND memory_is_log_series(NEW.name) THEN
    NEW.is_point_in_time := true;
  END IF;
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_writer_agent_from_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.writer_agent IS NULL THEN
    NEW.writer_agent := public.derive_writer_agent_from_source(NEW.source);
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.spreading_activation_rerank(p_ids uuid[], p_scores double precision[], p_link_weight double precision DEFAULT 0.15, p_max_hops integer DEFAULT 1)
 RETURNS TABLE(memory_id uuid, original_score double precision, boost double precision, final_score double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  v_count := array_length(p_ids, 1);
  IF array_length(p_scores, 1) IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'spreading_activation_rerank: p_ids (%) and p_scores (%) length mismatch',
      v_count, array_length(p_scores, 1);
  END IF;

  IF p_max_hops < 1 OR p_max_hops > 2 THEN
    RAISE EXCEPTION 'spreading_activation_rerank: p_max_hops must be 1 or 2, got %', p_max_hops;
  END IF;

  RETURN QUERY
  WITH seeds AS (
    SELECT
      p_ids[i]    AS id,
      p_scores[i] AS score,
      i           AS rank_idx
    FROM generate_series(1, v_count) AS i
  ),
  hop1 AS (
    SELECT s.id AS target, SUM(COALESCE(ml.strength, 0.5) * n.score) AS hop_boost
    FROM seeds s
    JOIN memory_links ml
      ON (ml.source_id = s.id OR ml.target_id = s.id)
    JOIN seeds n
      ON n.id = CASE WHEN ml.source_id = s.id THEN ml.target_id ELSE ml.source_id END
     AND n.id <> s.id
    GROUP BY s.id
  ),
  hop2 AS (
    SELECT s.id AS target,
           0.5 * SUM(COALESCE(ml1.strength, 0.5) * COALESCE(ml2.strength, 0.5) * n2.score) AS hop_boost
    FROM seeds s
    JOIN memory_links ml1
      ON (ml1.source_id = s.id OR ml1.target_id = s.id)
    JOIN memory_links ml2
      ON (
        ml2.source_id = CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END
        OR ml2.target_id = CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END
      )
    JOIN seeds n2
      ON n2.id = CASE WHEN ml2.source_id = (CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END)
                      THEN ml2.target_id ELSE ml2.source_id END
     AND n2.id <> s.id
     AND n2.id <> (CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END)
    WHERE p_max_hops >= 2
    GROUP BY s.id
  ),
  boosts AS (
    SELECT target, SUM(hop_boost) AS total_boost
    FROM (
      SELECT target, hop_boost FROM hop1
      UNION ALL
      SELECT target, hop_boost FROM hop2
    ) u
    GROUP BY target
  )
  SELECT
    s.id                                                              AS memory_id,
    s.score                                                            AS original_score,
    (COALESCE(b.total_boost, 0) * p_link_weight)::double precision     AS boost,
    (s.score + COALESCE(b.total_boost, 0) * p_link_weight)::double precision AS final_score
  FROM seeds s
  LEFT JOIN boosts b ON b.target = s.id
  ORDER BY 4 DESC, s.rank_idx ASC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.supersede_memory(p_old_id uuid, p_new_id uuid, p_reason text DEFAULT NULL::text, p_heuristic text DEFAULT 'last_writer_wins'::text)
 RETURNS TABLE(old_id uuid, new_id uuid, rewired_links integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rewired int := 0;
BEGIN
  IF p_old_id IS NULL OR p_new_id IS NULL THEN
    RAISE EXCEPTION 'supersede_memory: both p_old_id and p_new_id required';
  END IF;
  IF p_old_id = p_new_id THEN
    RAISE EXCEPTION 'supersede_memory: cannot supersede a memory with itself';
  END IF;
  IF p_heuristic IS NULL OR p_heuristic <> ALL (ARRAY[
       'last_writer_wins','evidence_weighted_merge','await_confirmation','per_rule_policy']) THEN
    RAISE EXCEPTION 'supersede_memory: invalid heuristic %, expected a TOKI operator', p_heuristic;
  END IF;
  PERFORM 1 FROM memories WHERE id = p_old_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: old memory % not found', p_old_id; END IF;
  PERFORM 1 FROM memories WHERE id = p_new_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supersede_memory: new memory % not found', p_new_id; END IF;

  UPDATE memories
     SET superseded_by = p_new_id, is_active = false, updated_at = now()
   WHERE id = p_old_id;

  WITH inbound AS (
    SELECT source_id, relationship, COALESCE(link_type, 'semantic') AS link_type, COALESCE(strength, 0.5) AS strength
    FROM memory_links
    WHERE target_id = p_old_id AND source_id <> p_new_id
  )
  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
  SELECT source_id, p_new_id, relationship, link_type, strength FROM inbound
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
  GET DIAGNOSTICS v_rewired = ROW_COUNT;

  INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  VALUES (p_old_id, p_new_id, 'supersedes', 'temporal', 1.0,
          jsonb_build_object('resolution_heuristic', p_heuristic, 'reason', p_reason))
  ON CONFLICT (source_id, target_id, relationship)
    DO UPDATE SET metadata = COALESCE(memory_links.metadata, '{}'::jsonb)
                             || jsonb_build_object('resolution_heuristic', p_heuristic);

  BEGIN
    INSERT INTO memory_log (memory_id, action, details)
    VALUES (p_old_id, 'supersede', jsonb_build_object(
      'superseded_by', p_new_id, 'reason', p_reason, 'resolution_heuristic', p_heuristic));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN QUERY SELECT p_old_id, p_new_id, v_rewired;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.supersession_head(p_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cur   uuid := p_id;
  v_next  uuid;
  v_seen  uuid[] := ARRAY[]::uuid[];
  v_depth integer := 0;
BEGIN
  WHILE v_cur IS NOT NULL AND v_depth < 32 LOOP
    IF v_cur = ANY(v_seen) THEN
      RETURN NULL;  -- cycle: no defensible head, caller falls back to de-weight
    END IF;
    v_seen := v_seen || v_cur;
    SELECT superseded_by INTO v_next FROM memories WHERE id = v_cur;
    IF v_next IS NULL THEN
      RETURN v_cur;
    END IF;
    v_cur := v_next;
    v_depth := v_depth + 1;
  END LOOP;
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sweep_conflicts(p_limit integer DEFAULT 200, p_actor text DEFAULT 'conflict-sweep'::text, p_types text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          RECORD;
  v_res      jsonb;
  v_actions  jsonb := '{}'::jsonb;
  v_action   text;
  v_total    integer := 0;
  v_errors   integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM memory_conflicts
    WHERE COALESCE(resolved, false) = false
      AND (p_types IS NULL OR conflict_type = ANY(p_types))
    ORDER BY created_at ASC
    LIMIT p_limit
  LOOP
    BEGIN
      v_res := public.resolve_conflict_auto(r.id, p_actor);
      v_action := v_res->>'action';
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not abort the sweep.
      v_errors := v_errors + 1;
      v_action := 'error';
    END;
    v_total := v_total + 1;
    v_actions := jsonb_set(v_actions, ARRAY[v_action],
                           to_jsonb(COALESCE((v_actions->>v_action)::integer, 0) + 1));
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_total,
    'errors', v_errors,
    'actions', v_actions,
    'open_conflicts_remaining',
      (SELECT count(*) FROM memory_conflicts WHERE COALESCE(resolved, false) = false));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.task_is_retired_nightly_consolidation(p_title text, p_description text, p_source text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(p_source, '') = 'cowork'
     AND (
           btrim(COALESCE(p_title, '')) IN (
             'Run nightly episodic memory consolidation',
             'Send nightly consolidation notification to Discord'
           )
           OR COALESCE(p_description, '') ILIKE '%consolidate_episodic_memories.py%'
         );
$function$
;

CREATE OR REPLACE FUNCTION public.task_needs_host_remediation(p_title text, p_description text, p_context jsonb, p_tags text[])
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_haystack text;
  v_alert_emails text;
BEGIN
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

  RETURN
       v_haystack ~ '\m(down|crashed|unreachable|offline)\M'
    OR v_haystack ~ '\mrestart\M'
    OR v_haystack ~ '\m(service\s+health|health\s*check|healthcheck)\M'
    OR v_haystack ~ '\m(container|podman|docker)\M'
    OR v_haystack ~ '\m(lxc|vm|proxmox)\M'
    OR v_haystack ~ '\m(systemd|systemctl)\M'
    OR v_haystack ~ '\mdeploy(ed|ment)?\M'
    OR v_haystack ~ '\m(ssh|host[- ]side)\M'
    OR v_haystack ~ '\mup\s+at\M'
    OR v_haystack ~ '\bhomebridge\b'
    OR v_haystack ~ '\bamp\s+(game\s+)?server\b'
    OR v_haystack ~ '\buptime[- ]?kuma\b';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.task_queue_set_trace_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.trace_id IS NULL THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      SELECT trace_id INTO NEW.trace_id FROM task_queue WHERE id = NEW.parent_task_id;
    END IF;
    IF NEW.trace_id IS NULL THEN
      NEW.trace_id := NEW.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.task_queue_stamp_archived_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Recurring templates park at status='completed' between fires and are reset
  -- to 'ready' by the upstream UPSERT. Stamping them would hide them from
  -- atlas-queue-check.sh / sentinel / lumen and kill the recurring schedule.
  IF NEW.recurring IS TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('completed', 'cancelled', 'archived') THEN
    IF NEW.archived_at IS NULL THEN
      NEW.archived_at := now();
    END IF;

  ELSIF TG_OP = 'UPDATE'
        AND OLD.status IN ('completed', 'cancelled', 'archived')
        AND NEW.archived_at IS NOT NULL
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    -- Task reopened (terminal -> non-terminal). Clear the stale stamp, but only
    -- if this statement did not set archived_at deliberately.
    NEW.archived_at := NULL;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_scheduled_activity_touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.touch_memory(memory_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE memories
  SET
    access_count = COALESCE(access_count, 0) + 1,
    accessed_at = now(),
    last_accessed_at = now()
  WHERE id = memory_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trust_tier_to_heuristic(p_tier_a text, p_tier_b text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH t AS (
    SELECT LOWER(COALESCE(p_tier_a, 'unknown')) AS a,
           LOWER(COALESCE(p_tier_b, 'unknown')) AS b
  )
  SELECT CASE
    -- A weak side (low or quarantined) contradicting a strong side (high or
    -- verified) is exactly the condition the paper found belief-based memory
    -- beats last-write-wins. Do not auto-resolve; ask a human.
    WHEN (a IN ('low','quarantined') AND b IN ('high','verified'))
      OR (b IN ('low','quarantined') AND a IN ('high','verified'))
      THEN 'await_confirmation'

    -- Medium is attributable but indirect; both sides are vouched for, so
    -- temporal order is a safe tiebreak.
    ELSE 'last_writer_wins'
  END
  FROM t;
$function$
;

CREATE OR REPLACE FUNCTION public.trust_weight(p_tier text)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE COALESCE(p_tier, 'unknown')
    WHEN 'high'        THEN 1.00
    WHEN 'medium'      THEN 0.95
    WHEN 'unknown'     THEN 0.90
    WHEN 'low'         THEN 0.75
    WHEN 'quarantined' THEN 0.40
    ELSE 0.90
  END::double precision
$function$
;

CREATE OR REPLACE FUNCTION public.unretire_memory(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE memories SET is_active = true, retired_at = NULL, retire_reason = NULL WHERE id = p_id;
  RETURN FOUND;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.unverified_high_recall_memories(p_min_recall_count integer DEFAULT 10, p_min_importance double precision DEFAULT 0.7, p_stale_days integer DEFAULT 30, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, name text, type text, recall_count integer, importance_score double precision, verified_at timestamp with time zone, verification_age_days double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    m.id,
    m.name,
    m.type,
    COALESCE(m.recall_count, 0)::integer AS recall_count,
    COALESCE(m.importance_score, 0.5)::double precision AS importance_score,
    m.verified_at,
    CASE
      WHEN m.verified_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (now() - m.verified_at)) / 86400.0
    END AS verification_age_days
  FROM memories m
  WHERE COALESCE(m.recall_count, 0) >= p_min_recall_count
    AND COALESCE(m.importance_score, 0.5) >= p_min_importance
    AND (m.verified_at IS NULL OR m.verified_at < now() - (p_stale_days || ' days')::interval)
  ORDER BY m.recall_count DESC NULLS LAST, m.importance_score DESC
  LIMIT p_limit;
$function$
;

CREATE OR REPLACE FUNCTION public.update_goal_progress_from_tasks()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_goal_id uuid;
  v_total   int;
  v_done    int;
  v_progress int;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_goal_id := NEW.goal_id;
  IF v_goal_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if user has manually locked the progress value
  IF EXISTS (SELECT 1 FROM goals WHERE id = v_goal_id AND progress_locked = true) THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'completed')
  INTO v_total, v_done
  FROM task_queue
  WHERE goal_id = v_goal_id;

  IF v_total = 0 THEN
    RETURN NEW;
  END IF;

  v_progress := ROUND((v_done::numeric / v_total::numeric) * 100);

  UPDATE goals
  SET progress   = v_progress,
      status     = CASE WHEN v_progress = 100 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN v_progress = 100 AND completed_at IS NULL THEN NOW() ELSE completed_at END,
      updated_at = NOW()
  WHERE id = v_goal_id
    AND status NOT IN ('planned', 'paused');

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_memory_verified(p_memory_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMP WITH TIME ZONE := now();
BEGIN
  UPDATE memories
  SET verified_at = v_now,
      staleness_candidate = false
  WHERE id = p_memory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory % not found', p_memory_id;
  END IF;
  RETURN v_now;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_read_watermark(p_agent_name text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  INSERT INTO public.agent_read_watermarks (agent_name, last_seen_at, updated_at)
  VALUES (p_agent_name, v_now, v_now)
  ON CONFLICT (agent_name) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
        updated_at   = EXCLUDED.updated_at;
  RETURN v_now;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_user_preferences_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_agent_heartbeat(p_agent text, p_prompt_count integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  insert into agent_heartbeat (agent, status, last_heartbeat, prompt_count, updated_at)
  values (p_agent, 'healthy', now(), p_prompt_count, now())
  on conflict (agent) do update set
    status = 'healthy',
    last_heartbeat = now(),
    prompt_count = p_prompt_count,
    updated_at = now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_credential(p_admin_token text, p_master_key text, p_name text, p_type text, p_secret text, p_username text DEFAULT NULL::text, p_host text DEFAULT NULL::text, p_port integer DEFAULT NULL::integer, p_notes text DEFAULT NULL::text, p_tags text[] DEFAULT '{}'::text[], p_projects text[] DEFAULT '{}'::text[], p_agents text[] DEFAULT '{}'::text[], p_caller text DEFAULT 'unknown'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
    IF NOT verify_admin_token(p_admin_token) THEN
        INSERT INTO credential_access_log (credential_name, accessed_by, action, success, detail)
        VALUES (p_name, p_caller, 'write', false, 'invalid admin token');
        RAISE EXCEPTION 'unauthorized: invalid admin token';
    END IF;

    INSERT INTO credentials (name, type, secret_enc, username, host, port, notes, tags, projects, agents, created_by)
    VALUES (
        p_name, p_type,
        pgp_sym_encrypt(p_secret, p_master_key),
        p_username, p_host, p_port, p_notes, p_tags, p_projects, p_agents,
        p_caller
    )
    ON CONFLICT (name) DO UPDATE SET
        type        = EXCLUDED.type,
        secret_enc  = EXCLUDED.secret_enc,
        username    = EXCLUDED.username,
        host        = EXCLUDED.host,
        port        = EXCLUDED.port,
        notes       = EXCLUDED.notes,
        tags        = EXCLUDED.tags,
        projects    = EXCLUDED.projects,
        agents      = EXCLUDED.agents,
        updated_at  = now();

    INSERT INTO credential_access_log (credential_name, accessed_by, action, success)
    VALUES (p_name, p_caller, 'write', true);

    RETURN 'ok';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_grimoire_daily_stats(p_user_id text, p_project_id uuid, p_date date, p_words_added integer, p_net_words integer, p_active_minutes integer, p_idle_minutes integer, p_ai_assists integer, p_chapters_touched integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO grimoire_daily_stats (
    user_id, project_id, date,
    words_added, net_words, active_minutes, idle_minutes,
    ai_assists, chapters_touched, sessions_count
  ) VALUES (
    p_user_id, p_project_id, p_date,
    p_words_added, p_net_words, p_active_minutes, p_idle_minutes,
    p_ai_assists, p_chapters_touched, 1
  )
  ON CONFLICT (user_id, project_id, date) DO UPDATE SET
    words_added     = grimoire_daily_stats.words_added     + EXCLUDED.words_added,
    net_words       = grimoire_daily_stats.net_words       + EXCLUDED.net_words,
    active_minutes  = grimoire_daily_stats.active_minutes  + EXCLUDED.active_minutes,
    idle_minutes    = grimoire_daily_stats.idle_minutes    + EXCLUDED.idle_minutes,
    ai_assists      = grimoire_daily_stats.ai_assists      + EXCLUDED.ai_assists,
    chapters_touched = GREATEST(grimoire_daily_stats.chapters_touched, EXCLUDED.chapters_touched),
    sessions_count  = grimoire_daily_stats.sessions_count  + 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_recurring_task(p_title text, p_description text, p_context jsonb, p_priority integer, p_source text, p_target text, p_tags text[], p_recurring_key text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid;
  v_run jsonb := jsonb_build_object('run_at', to_jsonb(now()), 'status', 'ready', 'result', null, 'notes', null);
  v_target text;
BEGIN
  -- Discord-delivery recurring keys MUST route to wren/claude-code (poll_queue filter).
  -- Never allow external target override for these critical recurring tasks.
  IF p_recurring_key IN (
    'breakthrough-watch',
    'daily-ai-memory-research',
    'weekly-rls-audit',
    'weekly-constitution-audit'
  ) THEN
    v_target := 'wren';
  ELSE
    v_target := COALESCE(p_target, 'claude-code');
  END IF;

  INSERT INTO public.task_queue
    (title, description, context, priority, status, source, target, tags,
     recurring, recurring_key, last_run_at, run_count, runs)
  VALUES
    (p_title, p_description, COALESCE(p_context, '{}'::jsonb), p_priority,
     'ready', p_source, v_target, COALESCE(p_tags, '{}'::text[]),
     true, p_recurring_key, now(), 1, jsonb_build_array(v_run))
  ON CONFLICT (recurring_key) WHERE recurring = true
  DO UPDATE SET
    title         = EXCLUDED.title,
    description   = EXCLUDED.description,
    context       = EXCLUDED.context,
    priority      = EXCLUDED.priority,
    target        = v_target,
    tags          = EXCLUDED.tags,
    status        = 'ready',
    claimed_by    = NULL,
    claimed_at    = NULL,
    result        = NULL,
    error         = NULL,
    last_run_at   = now(),
    run_count     = public.task_queue.run_count + 1,
    runs          = public.task_queue.runs || v_run,
    updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_recurring_task(p_recurring_key text, p_title text, p_description text, p_context jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 2, p_target text DEFAULT NULL::text, p_source text DEFAULT 'cowork'::text, p_tags text[] DEFAULT '{}'::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_run jsonb := jsonb_build_object('run_at', to_jsonb(now()), 'status', 'ready', 'result', null, 'notes', null);
  v_target text;
BEGIN
  -- Discord-delivery recurring keys must route to wren — only Wren has
  -- agent-bus send_discord. Override any upstream target value for these.
  IF p_recurring_key IN (
    'breakthrough-watch',
    'daily-ai-memory-research',
    'weekly-rls-audit',
    'weekly-constitution-audit'
  ) THEN
    v_target := 'wren';
  ELSE
    v_target := COALESCE(p_target, 'claude-code');
  END IF;

  INSERT INTO public.task_queue
    (title, description, context, priority, status, source, target, tags,
     recurring, recurring_key, last_run_at, run_count, runs)
  VALUES
    (p_title, p_description, COALESCE(p_context, '{}'::jsonb), p_priority,
     'ready', p_source, v_target, COALESCE(p_tags, '{}'::text[]),
     true, p_recurring_key, now(), 1, jsonb_build_array(v_run))
  ON CONFLICT (recurring_key) WHERE recurring = true
  DO UPDATE SET
    title         = EXCLUDED.title,
    description   = EXCLUDED.description,
    context       = EXCLUDED.context,
    priority      = EXCLUDED.priority,
    target        = v_target,
    tags          = EXCLUDED.tags,
    status        = 'ready',
    claimed_by    = NULL,
    claimed_at    = NULL,
    result        = NULL,
    error         = NULL,
    last_run_at   = now(),
    run_count     = public.task_queue.run_count + 1,
    runs          = public.task_queue.runs || v_run,
    updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_scheduled_activity(p_name text, p_kind text, p_schedule text, p_source_ref jsonb, p_display_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_tags text[] DEFAULT '{}'::text[], p_enabled boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     UUID;
  v_before JSONB;
  v_action TEXT;
BEGIN
  SELECT id, jsonb_build_object(
    'schedule', schedule,
    'enabled',  enabled,
    'source_ref', source_ref,
    'display_name', display_name,
    'description', description,
    'tags', tags
  ) INTO v_id, v_before
  FROM public.scheduled_activity WHERE name = p_name;

  INSERT INTO public.scheduled_activity
    (name, kind, schedule, source_ref, display_name, description, tags, enabled)
  VALUES
    (p_name, p_kind, p_schedule, p_source_ref, p_display_name, p_description, p_tags, p_enabled)
  ON CONFLICT (name) DO UPDATE SET
    kind         = EXCLUDED.kind,
    schedule     = EXCLUDED.schedule,
    source_ref   = EXCLUDED.source_ref,
    display_name = COALESCE(EXCLUDED.display_name, public.scheduled_activity.display_name),
    description  = COALESCE(EXCLUDED.description,  public.scheduled_activity.description),
    tags         = EXCLUDED.tags,
    enabled      = EXCLUDED.enabled
  RETURNING id INTO v_id;

  v_action := CASE WHEN v_before IS NULL THEN 'created' ELSE 'updated' END;

  INSERT INTO public.scheduled_activity_audit
    (scheduled_activity_id, scheduled_activity_name, action, actor, before, after)
  VALUES
    (v_id, p_name, v_action, 'auto-seeder', v_before, jsonb_build_object(
      'schedule', p_schedule, 'enabled', p_enabled, 'source_ref', p_source_ref,
      'display_name', p_display_name, 'description', p_description, 'tags', p_tags
    ));

  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.verify_admin_token(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM credential_admins
        WHERE token_hash = crypt(p_token, token_hash)
    );
END;
$function$
;
