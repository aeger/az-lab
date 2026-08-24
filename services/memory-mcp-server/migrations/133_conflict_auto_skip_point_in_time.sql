-- 133: stop resolve_conflict_auto() retiring point-in-time dated log series.
--
-- CASE B treats any two conflicting rows as rival values and supersedes the
-- older. Applied to a dated series that is a category error: the 2026-08-24
-- 03:30Z sweep retired 18 point-in-time rows (dreaming summaries, constitution
-- audits, daily research) in favour of whichever entry happened to be newest.
-- All 18 were restored by hand; this guard stops it recurring. CASE A (stale
-- propagation) is untouched, as is every explicit supersede_memory() caller.
--
-- Patches the LIVE definition rather than restating it, so this cannot silently
-- revert unrelated drift. Raises if the anchor moves.
DO $mig133$
DECLARE
  v_def   text;
  v_new   text;
  v_anchor text := '  -- ═══ CASE B: genuine value conflict';
  v_guard text := $guard$  -- ═══ GUARD (migration 133, 2026-08-24) ════════════════════════════════════
  -- A point-in-time record is not a rival value. Two dated entries in a log
  -- series (daily research, dreaming summaries, constitution audits) differ
  -- because they describe DIFFERENT DAYS, not because one of them is wrong.
  -- A point-in-time record cannot be superseded by a later fact -- that is what
  -- point-in-time means. Leave the pair for a human/agent instead of guessing.
  IF (SELECT is_point_in_time FROM memories WHERE id = a.id)
     OR (SELECT is_point_in_time FROM memories WHERE id = b.id) THEN
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
      'reason', 'point-in-time record cannot be superseded by a later fact');
  END IF;

$guard$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'resolve_conflict_auto' AND n.nspname = 'public';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 133: resolve_conflict_auto not found';
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'migration 133: CASE B anchor not found -- function drifted, patch by hand';
  END IF;
  IF position('point-in-time record cannot be superseded' in v_def) > 0 THEN
    RAISE NOTICE 'migration 133: guard already present, skipping';
    RETURN;
  END IF;

  v_new := replace(v_def, v_anchor, v_guard || v_anchor);
  EXECUTE v_new;
  RAISE NOTICE 'migration 133: point-in-time guard installed in resolve_conflict_auto';
END
$mig133$;
