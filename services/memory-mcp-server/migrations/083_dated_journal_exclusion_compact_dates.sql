-- Migration 083: extend the dated-journal exclusion to compact YYYYMMDD names.
--
-- WHY
--   Both contradiction detectors exclude dated journal entries with
--   `name !~ '\d{4}-\d{2}-\d{2}'`. That only matches the dashed form. 79 live
--   memories use the compact convention instead (research_closeout_20260713,
--   semantic:foo_20260724), so they were never excluded.
--
--   This surfaced immediately after migration 082 revived the predicate: all 3 of
--   its first detections were dated research-closeout entries diverging from each
--   other — precisely the case the exclusion exists to suppress, leaking through on
--   a naming-format technicality.
--
--   New predicate: name !~ '(\d{4}-\d{2}-\d{2}|(19|20)\d{6})'
--   The (19|20) prefix anchors the compact branch to plausible years so an 8-digit
--   ID or port range is not mistaken for a date.
--
-- METHOD
--   Guarded in-place patch: assert the old predicate appears EXACTLY once in each
--   function before replacing, and abort the migration if the body has drifted.
--   Idempotent — re-running detects the new predicate and skips.

DO $patch$
DECLARE
  v_fn   text;
  v_def  text;
  v_hits integer;
  v_old  text := 'name !~ ''\d{4}-\d{2}-\d{2}''';
  v_new  text := 'name !~ ''(\d{4}-\d{2}-\d{2}|(19|20)\d{6})''';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['scan_memory_contradictions', 'detect_temporal_supersession'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'migration 083: % not found', v_fn;
    END IF;

    IF position(v_new in v_def) > 0 THEN
      RAISE NOTICE 'migration 083: % already patched, skipping', v_fn;
      CONTINUE;
    END IF;

    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'migration 083: expected exactly 1 dated-journal predicate in %, found % - drifted, aborted', v_fn, v_hits;
    END IF;

    EXECUTE replace(v_def, v_old, v_new);
    RAISE NOTICE 'migration 083: patched dated-journal exclusion in %', v_fn;
  END LOOP;
END
$patch$;
