-- 136_retire_record_daily_research.sql — 2026-08-24
--
-- RETIRES public.record_daily_research(date, text, text, text[]) — migration 125.
-- Jeff's call at the verify-gate on the re-adjudication of task a18679f8.
--
-- WHY 125 WAS BUILT
--   "Iris runs cloud-side as a claude.ai routine and cannot reach LAN-only
--   memory-mcp, so the `remember` tool is off the table and Supabase RPC is the
--   only reachable write path." The engineering was correct. The premise was not.
--
-- WHY THE PREMISE IS FALSE (measured 2026-08-24)
--   The cloud surface already had a working write path and was using it daily.
--   The actual executing artifact behind the daily-research producer is the CCR
--   routine `ai-memory-research`, trigger id trig_012pickAjxmifxbhMbCe95Em,
--   cron `0 9 * * *`, environment env_015CLn9yRm3MdAcLbd2B3tiC, model
--   claude-sonnet-4-6, enabled, last_fired 2026-08-24T09:08:41Z. It runs in
--   Anthropic's cloud with ONE MCP connection: Supabase. Step 4 of its own
--   prompt is a literal `INSERT INTO memories (...) VALUES (...)` via
--   execute_sql. Raw table INSERT — no RPC, no memory-mcp, no LAN.
--
--   So `source='ai-memory-research-trigger', writer_agent='wren'` on those rows
--   is NOT attestation (v12.2 / v17.1): the source string is self-declared by
--   that prompt, and writer_agent='wren' is DERIVED by migration 051's
--   BEFORE-INSERT autofill because the INSERT supplies no writer_agent at all.
--   Nothing named wren executes it.
--
-- HAS 125 EVER BEEN CALLED — NO
--   record_daily_research pins name='Daily Self-Improvement Research - <date>',
--   source='claude-ai', writer_agent='iris'. That row shape has never existed:
--     * every 'Daily Self-Improvement Research - *' row is source='claude-code',
--       writer_agent atlas (08-19..08-24) or wren (through 08-17);
--     * memories rows with source='claude-ai' since 2026-08-21: 0. The most
--       recent claude-ai write of ANY kind is 2026-05-03 07:01Z;
--     * the 5 memory_log rows carrying source='claude-ai' since 125 landed are
--       all action='update' on pre-existing claude-ai rows (Wren's 08-22 stale
--       re-verification sweep), not a create from this function.
--   pg_stat_user_functions cannot corroborate — track_functions='none' on this
--   instance, so it has never recorded a call for ANY function. The row-shape
--   argument stands on its own: the function cannot write without leaving that
--   row, and that row does not exist.
--
-- DOES ANY CALLER NEED IT — NO
--   Iris's live write path is a direct INSERT stamped source='cowork'
--   (writer_agent='iris': 110 rows, 12 touched since 2026-08-22, latest
--   2026-08-24 18:28Z). No function body in the database references
--   record_daily_research; grep over ~/azlab and ~/claude finds no caller
--   outside migration 125 itself.
--
-- WHY RETIRE RATHER THAN LEAVE IT
--   It is SECURITY DEFINER and writes memories. anon was correctly revoked by
--   125, and proacl today is {postgres,authenticated,service_role} — so this is
--   not an open door. But `authenticated` retains EXECUTE on an owner-privileged
--   writer that stamps rows iris/claude-ai, i.e. a path to author memories under
--   another agent's identity, held open for a caller that does not exist. Zero
--   callers is the cheapest moment to close it; it can be re-created verbatim
--   from 125 if a cloud caller ever needs an RPC instead of an INSERT.
--
-- NOT AFFECTED: migration 124's derive/cap, 126/126a's producer registry, and
-- the daily-research rows themselves. This drops a function, no data.

BEGIN;

DO $guard$
DECLARE
  v_rows    int;
  v_callers int;
BEGIN
  -- Refuse to drop if the function turns out to have written after all.
  SELECT count(*) INTO v_rows
  FROM public.memories
  WHERE name LIKE 'Daily Self-Improvement Research - %'
    AND source = 'claude-ai'
    AND writer_agent = 'iris';
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'migration 136: % row(s) match record_daily_research''s output shape — it HAS been used; re-adjudicate before dropping', v_rows;
  END IF;

  -- Refuse to drop if anything in the database calls it.
  SELECT count(*) INTO v_callers
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prokind = 'f'
    AND p.proname <> 'record_daily_research'
    AND p.prosrc ILIKE '%record_daily_research%';
  IF v_callers > 0 THEN
    RAISE EXCEPTION 'migration 136: % function(s) reference record_daily_research — fix the callers first', v_callers;
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.record_daily_research(date, text, text, text[]);

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_daily_research'
  ) THEN
    RAISE EXCEPTION 'migration 136: record_daily_research still present after DROP';
  END IF;
  RAISE NOTICE 'migration 136: record_daily_research retired — 0 rows written, 0 callers, SECURITY DEFINER surface closed';
END
$verify$;

COMMIT;
