-- 127: put `extensions` back on the search_path of every function that uses a
--      pgvector distance operator.
--
-- DEFECT (found 2026-08-23 while consolidating 12 duplicate research skills)
-- pgvector is installed in schema `extensions` on this project. A search_path
-- hardening pass set `SET search_path = public, pg_temp` on a batch of functions,
-- which drops `extensions` — so `<=>` is not resolvable inside those function bodies
-- and EVERY call fails at startup with:
--
--   42883: operator does not exist: extensions.vector <=> extensions.vector
--
-- hybrid_recall and match_episodes were given `public, extensions, pg_temp` and kept
-- working, which is why memory recall looked healthy and nobody noticed the rest.
--
-- HOW IT HID (this is the part worth remembering)
-- index.ts::recall_skill swallows the RPC error — `if (!error && data?.length > 0)`
-- — and falls through to an ILIKE substring scan over name/title/description. It
-- therefore never surfaced an error; it silently degraded to substring matching.
-- A query like "daily self-improvement research" substring-matched the old skill
-- names and looked fine. "daily research run" and "research agent run" matched
-- nothing and returned "No matching skills found."
--
-- That is the real reason six months of daily-research runs concluded no skill
-- existed and saved a thirteenth one: semantic skill recall was dead, not merely
-- trigger-less. (Empty triggers is a separate, real defect — it blinds
-- poll_queue.py::_match_skill, which is what the nightly gate calls "unreachable".)
--
-- FIX
-- Repair the whole class, keyed on what actually breaks: a function body containing a
-- pgvector operator. Keying on a name pattern like `match\_%` both misses
-- link_memories_to_skills / hybrid_search_memories / find_duplicate_memories /
-- discard_redundant_memories / auto_detect_conflicts (all broken, all found by this
-- predicate) and wrongly flags match_skill_for_text, which is the pure-text mirror of
-- poll_queue.py::_match_skill and is CORRECT on the narrower `public, pg_temp`.
--
-- `pg_temp` stays last, so the CVE-2018-1058 hardening these functions were given is
-- preserved. This restores one trusted, extension-owned schema to functions that
-- cannot run without it; it does not revert anything to a mutable search_path.

DO $$
DECLARE fn record; n int := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
    WHERE n2.nspname = 'public'
      AND p.prokind = 'f'
      AND (p.prosrc LIKE '%<=>%' OR p.prosrc LIKE '%<->%' OR p.prosrc LIKE '%<#>%')
      AND NOT (array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') LIKE '%extensions%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn.sig);
    RAISE NOTICE 'migration 127: repaired search_path on %', fn.sig;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'migration 127: repaired % function(s)', n;
END $$;

-- Verify: no vector-using function may be left without `extensions`.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname = 'public'
    AND p.prokind = 'f'
    AND (p.prosrc LIKE '%<=>%' OR p.prosrc LIKE '%<->%' OR p.prosrc LIKE '%<#>%')
    AND NOT (array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') LIKE '%extensions%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 127: vector-using function(s) still missing extensions: %', bad;
  END IF;
END $$;

-- Smoke test: match_skills must actually execute. Before 127 this raised 42883.
DO $$
DECLARE hits int;
BEGIN
  SELECT count(*) INTO hits
  FROM public.match_skills((SELECT embedding FROM public.skills WHERE embedding IS NOT NULL LIMIT 1), 3);
  IF hits = 0 THEN
    RAISE EXCEPTION 'migration 127: match_skills returned 0 rows against an embedded corpus';
  END IF;
  RAISE NOTICE 'migration 127: match_skills smoke test returned % rows', hits;
END $$;
