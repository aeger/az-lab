-- Migration 076: wire scan_memory_for_injection to force quarantined on hits
-- Ref: 2026-07-27 daily research, rec 1; migration 061 (trust_weight defining quarantined=0.40)
--
-- THE PROBLEM
--   Migration 061 defined trust_tier='quarantined' with a soft weight of 0.40 (lowest before
--   hard filtering). But 0 rows ever reach this tier. The injection scanner exists
--   (migration 041 — scan_memory_for_injection trigger on every INSERT) and detects
--   poisoning attempts, but does NOT set quarantined when a hit occurs. Instead, it
--   derives trust_tier from provenance only, leaving 'quarantined' unreachable.
--
-- THE FIX
--   Modify scan_memory_for_injection() to force trust_tier='quarantined' when the
--   injection detector returns a hit. This converts the latent quarantined tier into
--   an active defense: poisoned writes land at weight 0.40 and must clear a higher
--   bar to appear in recall, even if their provenance would normally rank them higher.
--
-- WHY A PATCH, NOT A FULL CREATE OR REPLACE
--   scan_memory_for_injection() is ~100 lines (trust derivation, injection scanning,
--   sidecar table updates). Retyping it to add one conditional would be the higher-risk
--   edit (transcription slip, missing a detail, silent change to behavior). Instead,
--   we patch the deployed function in place: find the trust_tier assignment and add
--   an override guard that forces quarantined only when injection is detected.

DO $patch$
DECLARE
  v_def  text;
  v_hits integer;
  v_search text;
  v_replacement text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 076: scan_memory_for_injection not found';
  END IF;

  -- Idempotency: if the patch is already applied, bail out.
  IF position('quarantined on injection' in v_def) > 0 THEN
    RAISE NOTICE 'migration 076: injection quarantine already wired, skipping patch';
    RETURN;
  END IF;

  -- Find the existing trust_tier assignment. scan_memory_for_injection() calls
  -- derive_trust_tier and assigns the result. We need to patch the assignment
  -- to conditionally override to 'quarantined' if the injection scan found something.
  v_search := 'new.trust_tier := public.derive_trust_tier(new.source, new.writer_agent);';
  v_replacement :=
    E'-- Assign trust tier from provenance, but override to quarantined if injection detected.\n' ||
    E'new.trust_tier := CASE\n' ||
    E'  WHEN v_injection_hit THEN ''quarantined''  -- quarantined on injection\n' ||
    E'  ELSE public.derive_trust_tier(new.source, new.writer_agent)\n' ||
    E'END;';

  v_hits := (length(v_def) - length(replace(v_def, v_search, ''))) / length(v_search);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'migration 076: expected exactly 1 derive_trust_tier assignment site in scan_memory_for_injection, found % — drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(v_def, v_search, v_replacement);
  RAISE NOTICE 'migration 076: injection detector now forces trust_tier=quarantined on hits';
END
$patch$;

COMMENT ON MIGRATION 076 IS
  'Wire scan_memory_for_injection to set trust_tier=quarantined when injection is detected (2026-07-27). Converts the 0.40 soft weight into an active defense: poisoned writes rank below provenance-trusted ones in hybrid_recall, even if both have similar relevance.';
