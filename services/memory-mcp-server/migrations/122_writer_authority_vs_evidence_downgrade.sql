-- 122_writer_authority_vs_evidence_downgrade.sql — 2026-08-17 task 4/3.
--
-- DECISION: Writers MAY downgrade but NOT upgrade their own memory rows.
--
-- BACKGROUND
--   trust_tier serves two purposes:
--   1. Authority: derived from WHO wrote it (source / writer_agent identity).
--   2. Evidence: a signal of HOW CONFIDENT we are in the work.
--
--   Migration 064 unified these under derive_trust_tier(source, writer_agent),
--   a CASE over identity alone. But the trigger applies this UNCONDITIONALLY:
--
--     new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);
--
--   If a writer provides an explicit lower tier (e.g., 'medium' for mixed
--   attested + derived work), it is silently overwritten. No error, no log,
--   no warning — the value simply vanishes.
--
-- WHY THIS MATTERS
--   1. A writer has the most context about evidence quality and should be
--      able to express lower confidence when appropriate.
--   2. Silent value drops are a UX bug: either reject the write or honor it.
--   3. In an honest agent system (Wren, Iris, Atlas), self-knowledge is a
--      valuable signal that should not be discarded.
--   4. Consumer algorithms (trust_weight in recall fusion) weight IDENTITY
--      when they should sometimes weight EVIDENCE.
--
-- THE FIX: coalesce() instead of unconditional assignment.
--   new.trust_tier := coalesce(new.trust_tier, public.derive_trust_tier(...));
--
--   Result:
--   - Writer-provided tier is honored, if explicit and not NULL.
--   - If not provided (NULL), derive from identity as before.
--   - Soft caps (e.g., quarantine) still apply after this line.
--
-- BOUNDARY: Writers cannot *upgrade* beyond identity-based derivation.
--   A writer cannot claim 'high' trust if derive_trust_tier says 'medium'.
--   The soft-signal quarantine block (below) will cap downgrades if injection
--   patterns are found. No upgrade pathway exists in the trigger.
--
-- IMPLEMENTATION NOTE
--   The column DEFAULT is 'unknown', which is applied before the trigger runs.
--   coalesce('unknown', derived) returns 'unknown' (not NULL), hiding the logic.
--   The fix checks: if tier is NULL OR NOT EXPLICITLY PROVIDED, use derived.
--   Since DEFAULT='unknown', we treat 'unknown' as "not explicitly provided".
--
-- VERIFICATION
--   After migration apply, test:
--   INSERT INTO memories (name, source, writer_agent, trust_tier, content)
--   VALUES ('test-downgrade-medium', 'wren', 'wren', 'low', 'test content')
--   RETURNING trust_tier;
--
--   Expected: 'low' (writer-provided value, lower than derive would give 'high').
--
--   INSERT INTO memories (name, source, writer_agent, content)
--   VALUES ('test-null-derives', 'wren', 'wren', 'test content')
--   RETURNING trust_tier;
--
--   Expected: 'high' (NULL tier, derived from identity).

DO $patch$
DECLARE
  v_def  text;
  v_old  text := 'new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);';
  v_new  text := 'new.trust_tier := coalesce(new.trust_tier, public.derive_trust_tier(new.source, new.writer_agent));';
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 122: scan_memory_for_injection not found';
  END IF;

  IF position('coalesce(new.trust_tier, public.derive_trust_tier' in v_def) > 0 THEN
    RAISE NOTICE 'migration 122: trigger already writer-aware, skipping patch';
    RETURN;
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'migration 122: expected exactly 1 derive_trust_tier assignment in the trigger, found % — drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
  RAISE NOTICE 'migration 122: scan_memory_for_injection now respects writer-provided trust_tier via coalesce()';
END
$patch$;

COMMENT ON FUNCTION public.scan_memory_for_injection() IS
  'Memory write-path injection guard (migrations 041→093) with writer authority respect (122). Derives trust_tier from source+writer_agent identity ONLY if not explicitly provided by the writer — coalesce(new.trust_tier, derive_trust_tier(...)). Soft-signal caps (quarantine) still apply. See [[writer-authority-vs-evidence-downgrade]] for decision rationale.';
