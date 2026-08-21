-- 125_iris_daily_research_write_path.sql — 2026-08-21 research impl 2/3.
--
-- PROBLEM
--   Recurring task 486da177 ('daily-ai-memory-research', run_count 136) delivers
--   Iris's daily research to Discord. Its context carries research_date but no
--   research_memory key, because Iris has no way to write one: Iris runs
--   cloud-side as a claude.ai routine and cannot reach LAN-only memory-mcp
--   (see memory `reference_ccr_routines`), so the `remember` tool is off the
--   table and Supabase RPC is the only reachable write path.
--
--   The consequence is an origin-binding inversion. The Discord post IS the
--   artifact — the only durable copy of a day's findings is a chat message in
--   #claude-code. Nothing in memories records what Iris actually found, so the
--   next run cannot dedup against it, hybrid_recall cannot surface it, and the
--   research that drives these very migrations is not itself remembered.
--
--   arXiv 2606.24535 calls the fix write-time origin binding: the stored row is
--   the original and every downstream rendering (Discord, digest, dashboard) is
--   a derivative that points back at it. This migration supplies the row.
--
-- WHAT THIS ADDS
--   public.record_daily_research(p_research_date, p_content, p_description,
--                                p_tags) -> jsonb
--
--   SECURITY DEFINER because memories has RLS enabled (relrowsecurity = true)
--   and the cloud-side caller is not the table owner.
--
-- PROVENANCE IS NOT A PARAMETER
--   type, name, source and writer_agent are fixed by the function body, not
--   accepted from the caller:
--       type = 'project'   source = 'claude-ai'   writer_agent = 'iris'
--       name = 'Daily Self-Improvement Research - <YYYY-MM-DD>'
--
--   There is deliberately NO trust_tier parameter. Migration 124 already
--   derives and caps the tier from (source, writer_agent), and a caller-facing
--   tier argument would just be a request the cap has to refuse — re-opening
--   in the RPC surface exactly the self-asserted-trust hole 124 closed at the
--   trigger. derive_trust_tier('claude-ai','iris') = 'medium' (rank 2), so
--   Iris's rows land at medium and cannot buy the 'high' ranking multiplier.
--   Verified live 2026-08-21: a low-deriving writer asking for 'high' stored
--   'low'. The probe at the bottom of this file re-asserts it for this path.
--
-- IDEMPOTENCY / THE NAME COLLISION THAT WOULD OTHERWISE BITE
--   memories carries a PARTIAL unique index:
--       memories_active_name_uidx ON memories (name) WHERE is_active
--   so a plain INSERT of today's name fails outright whenever a row for that
--   date already exists — which is the normal case, since the local pipeline
--   (wren/atlas) has been writing these names all along. A re-fire of the
--   routine would error rather than refresh. Hence ON CONFLICT ... DO UPDATE,
--   inferring that partial index by repeating its predicate.
--
--   The upsert overwrites content/description/tags for that date. That is the
--   intent — the row IS "the daily research for date D", and Iris is now its
--   author of record — and it is non-destructive: memories_audit
--   (log_memory_change) writes an 'update' row to memory_log carrying
--   old_content whenever content actually changes, so a clobbered prior
--   version stays recoverable.
--
--   Rows with the same name but is_active = false sit outside the partial
--   index and are correctly left alone; a new active row is inserted beside
--   them.
--
-- TWO DELIBERATE RESETS ON THE UPDATE BRANCH
--   trust_tier := 'unknown'
--     The row's provenance CHANGED on an overwrite (a wren-authored row is now
--     iris-authored). Leaving the inherited value would hand 124's cap an
--     inherited 'high' to argue with; 'unknown' is the documented
--     "please derive" sentinel (preserved by 122/123), so the tier is
--     recomputed from the new provenance instead of carried over. The cap
--     would clamp the inherited value to 'medium' anyway — this just makes the
--     intent explicit rather than incidental.
--
--   embedding := NULL
--     The content changed, so the stored vector no longer describes the row.
--     NULL is not a gap here: memory-mcp-server runs an embedding backfill
--     sweep (src/index.ts, startup then every 30 min) precisely for
--     direct-SQL writers that bypass the remember tool — it re-embeds and then
--     runs the standard detectConflicts pass. So the row joins the pgvector
--     RRF lane within ~30 minutes on its own. The BM25/trgm lanes never lapse
--     at all: search_vec and search_vector are STORED GENERATED columns, so
--     they are populated by the insert itself and the row is text-recallable
--     immediately.
--
-- WHAT STILL APPLIES, UNCHANGED
--   The row goes through every existing memories trigger. Notably
--   memories_injection_scan still scans name/description/content and can
--   quarantine the row on a soft-signal hit — appropriate, since this content
--   originates from web research read by a cloud agent. 124's ordering holds:
--   the provenance cap is a ceiling, the quarantine stomp is a floor.
--   set_point_in_time_from_name still flags is_point_in_time from the dated
--   name, and set_writer_agent_from_source leaves writer_agent alone because
--   this function always supplies it explicitly.

-- ---------------------------------------------------------------------------
-- The RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_daily_research(
  p_research_date date,
  p_content       text,
  p_description   text   DEFAULT NULL,
  p_tags          text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_name     text;
  v_desc     text;
  v_tags     text[];
  v_id       uuid;
  v_tier     text;
  v_inserted boolean;
BEGIN
  IF p_research_date IS NULL THEN
    RAISE EXCEPTION 'record_daily_research: p_research_date is required';
  END IF;

  -- Tolerate one day ahead for timezone skew (the routine fires ~16:20 UTC and
  -- the caller may compute the date locally), reject anything beyond that.
  IF p_research_date > ((now() AT TIME ZONE 'UTC')::date + 1) THEN
    RAISE EXCEPTION 'record_daily_research: p_research_date % is in the future', p_research_date;
  END IF;

  IF p_content IS NULL OR btrim(p_content) = '' THEN
    RAISE EXCEPTION 'record_daily_research: p_content is required and must not be blank';
  END IF;

  v_name := 'Daily Self-Improvement Research - ' || to_char(p_research_date, 'YYYY-MM-DD');

  v_desc := coalesce(
    nullif(btrim(coalesce(p_description, '')), ''),
    'Daily AI memory / self-improvement research findings for '
      || to_char(p_research_date, 'YYYY-MM-DD') || '.'
  );

  -- House tag convention for this series, plus whatever topical tags the
  -- caller adds. Deduped and blank-stripped; order is not significant.
  v_tags := ARRAY(
    SELECT DISTINCT t
    FROM unnest(
      ARRAY['research','ai-memory','daily-research','agentic']
      || coalesce(p_tags, ARRAY[]::text[])
    ) AS t
    WHERE btrim(coalesce(t, '')) <> ''
  );

  INSERT INTO public.memories AS m (
    type, name, description, content, tags,
    source, writer_agent, memory_class, trust_tier
  )
  VALUES (
    'project', v_name, v_desc, p_content, v_tags,
    'claude-ai', 'iris', 'semantic',
    'unknown'   -- sentinel: let the 124 trigger derive from provenance
  )
  ON CONFLICT (name) WHERE is_active DO UPDATE
    SET content      = EXCLUDED.content,
        description  = EXCLUDED.description,
        tags         = EXCLUDED.tags,
        type         = EXCLUDED.type,
        source       = EXCLUDED.source,
        writer_agent = EXCLUDED.writer_agent,
        trust_tier   = 'unknown',  -- re-derive: provenance changed on overwrite
        embedding    = NULL        -- content changed; backfill sweep re-embeds
  RETURNING m.id, m.trust_tier, (xmax::text = '0')
  INTO v_id, v_tier, v_inserted;

  RETURN jsonb_build_object(
    'id',            v_id,
    'name',          v_name,
    'research_date', to_char(p_research_date, 'YYYY-MM-DD'),
    'trust_tier',    v_tier,
    'writer_agent',  'iris',
    'source',        'claude-ai',
    'action',        CASE WHEN v_inserted THEN 'created' ELSE 'updated' END
  );
END
$function$;

COMMENT ON FUNCTION public.record_daily_research(date, text, text, text[]) IS
  'Write path for Iris''s daily research (cloud-side, cannot reach LAN memory-mcp). '
  'Upserts the canonical memories row for a date as type=project, source=claude-ai, '
  'writer_agent=iris. Provenance is fixed by the function; there is no trust_tier '
  'parameter — migration 124 derives and caps it. Returns {id,name,trust_tier,action}. '
  'Migration 125.';

-- Least privilege. Note this deliberately does NOT keep the default PUBLIC
-- EXECUTE grant that upsert_recurring_task still carries: this is a
-- SECURITY DEFINER function that writes memories, so anon must not reach it.
--
-- REVOKE FROM PUBLIC alone is NOT sufficient, and that is easy to get wrong.
-- Supabase ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new public
-- functions to anon and authenticated, so at CREATE time anon receives its own
-- EXPLICIT grant (proacl showed `anon=X/postgres` on first apply). Revoking
-- PUBLIC drops only the implicit grant and leaves anon's intact — anon must be
-- revoked by name. The anon key is public by design, so skipping this would
-- expose an unauthenticated write into memories stamped iris/claude-ai.
REVOKE ALL ON FUNCTION public.record_daily_research(date, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_daily_research(date, text, text, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_daily_research(date, text, text, text[])
  TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Verify — probe the real function against the real table, then clean up.
-- ---------------------------------------------------------------------------

DO $verify$
DECLARE
  v_probe_date date := DATE '1999-01-02';  -- far from any real research row
  v_r1      jsonb;
  v_r2      jsonb;
  v_id      uuid;
  v_row     public.memories%ROWTYPE;
  v_derived text;
  v_msg     text;
  v_nargs   int;
BEGIN
  -- Structural: there must be no trust_tier parameter to abuse.
  SELECT count(*) INTO v_nargs
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'record_daily_research'
    AND 'trust_tier' = ANY (coalesce(p.proargnames, ARRAY[]::text[]));
  IF v_nargs > 0 THEN
    RAISE EXCEPTION 'migration 125: record_daily_research exposes a trust_tier parameter — 124''s cap must not be re-openable from the RPC surface';
  END IF;

  -- Security: the anon role (public key, unauthenticated) must not be able to
  -- execute a SECURITY DEFINER writer. Supabase default privileges grant it at
  -- CREATE time, so this asserts the explicit revoke above actually landed.
  IF has_function_privilege('anon',
       'public.record_daily_research(date, text, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 125: anon still holds EXECUTE — REVOKE FROM PUBLIC does not remove the default-privileges grant to anon';
  END IF;

  v_derived := public.derive_trust_tier('claude-ai', 'iris');

  BEGIN
    v_r1 := public.record_daily_research(
      v_probe_date, 'migration 125 verify probe row', NULL, ARRAY['__mig125_probe']);
    v_id := (v_r1 ->> 'id')::uuid;

    -- Second call with the SAME date must UPDATE, not raise on the partial
    -- unique index. This is the case that would have broken on every re-fire.
    v_r2 := public.record_daily_research(
      v_probe_date, 'migration 125 verify probe row — second write', NULL, NULL);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    -- Best-effort cleanup before re-raising, so a failure leaves no residue.
    DELETE FROM memory_log WHERE memory_id = v_id;
    DELETE FROM memories   WHERE id = v_id;
    RAISE EXCEPTION 'migration 125: verify probe failed — %', v_msg;
  END;

  SELECT * INTO v_row FROM public.memories WHERE id = v_id;

  -- Clean up before asserting, so a failed assertion still leaves no residue.
  -- Mirrors 124: delete fires memories_audit and memories_forget_audit, so
  -- sweep both trails around the row delete.
  DELETE FROM memory_log          WHERE memory_id = v_id;
  DELETE FROM memories            WHERE id        = v_id;
  DELETE FROM memory_log          WHERE memory_id = v_id;
  DELETE FROM memory_forget_audit WHERE memory_id = v_id;

  IF (v_r1 ->> 'action') IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'migration 125: first write reported action=%, expected created', v_r1 ->> 'action';
  END IF;

  IF (v_r2 ->> 'action') IS DISTINCT FROM 'updated' THEN
    RAISE EXCEPTION 'migration 125: second write for the same date reported action=%, expected updated (partial-unique upsert is broken)', v_r2 ->> 'action';
  END IF;

  IF (v_r2 ->> 'id') IS DISTINCT FROM (v_r1 ->> 'id') THEN
    RAISE EXCEPTION 'migration 125: second write created a NEW row — one row per research date expected';
  END IF;

  IF v_row.name IS DISTINCT FROM 'Daily Self-Improvement Research - 1999-01-02' THEN
    RAISE EXCEPTION 'migration 125: name built as "%"', v_row.name;
  END IF;

  IF v_row.writer_agent IS DISTINCT FROM 'iris'
     OR v_row.source    IS DISTINCT FROM 'claude-ai'
     OR v_row.type      IS DISTINCT FROM 'project' THEN
    RAISE EXCEPTION 'migration 125: provenance not pinned — type=% source=% writer_agent=%',
      v_row.type, v_row.source, v_row.writer_agent;
  END IF;

  -- The whole point: tier comes from provenance, not from the caller.
  IF v_row.trust_tier IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION 'migration 125: trust_tier stored % but derive_trust_tier(claude-ai,iris) = %',
      coalesce(v_row.trust_tier, '<null>'), coalesce(v_derived, '<null>');
  END IF;

  IF v_row.content IS DISTINCT FROM 'migration 125 verify probe row — second write' THEN
    RAISE EXCEPTION 'migration 125: upsert did not refresh content';
  END IF;

  IF NOT (v_row.tags @> ARRAY['research','ai-memory','daily-research','agentic']) THEN
    RAISE EXCEPTION 'migration 125: house tags missing — got %', v_row.tags;
  END IF;

  -- Text lanes must be live immediately (stored generated columns).
  IF v_row.search_vec IS NULL OR v_row.search_vector IS NULL THEN
    RAISE EXCEPTION 'migration 125: tsvector columns not populated — row would be unrecallable until the embedding sweep runs';
  END IF;

  RAISE NOTICE 'migration 125: verified — created then updated one row, provenance pinned to iris/claude-ai, trust_tier derived as % (not caller-supplied), text lanes live', v_row.trust_tier;
END
$verify$;
