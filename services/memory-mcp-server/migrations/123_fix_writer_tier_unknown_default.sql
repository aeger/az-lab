-- 123_fix_writer_tier_unknown_default.sql — 2026-08-17 immediate follow-up.
--
-- PROBLEM WITH 122
--   Migration 122 used coalesce(new.trust_tier, derive_trust_tier(...)),
--   but the trust_tier column has DEFAULT='unknown'. So when a row is
--   INSERT-ed without an explicit tier, the DEFAULT 'unknown' is applied
--   BEFORE the trigger runs. Then coalesce('unknown', 'high') returns
--   'unknown', not 'high' — the derivation is bypassed.
--
-- THE FIX
--   Check for NULL OR 'unknown' to detect "not explicitly provided":
--     case when new.trust_tier is null or new.trust_tier = 'unknown'
--       then public.derive_trust_tier(...)
--       else new.trust_tier
--     end
--
--   This respects:
--   - Explicit user values ('low', 'medium', 'high', 'verified', 'quarantined')
--   - Treats 'unknown' as "please derive"
--   - Treats NULL as "please derive"

DO $patch$
DECLARE
  v_def  text;
  v_old  text := 'new.trust_tier := coalesce(new.trust_tier, public.derive_trust_tier(new.source, new.writer_agent));';
  v_new  text := 'new.trust_tier := case when new.trust_tier is null or new.trust_tier = ''unknown'' then public.derive_trust_tier(new.source, new.writer_agent) else new.trust_tier end;';
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 123: scan_memory_for_injection not found';
  END IF;

  IF position('when new.trust_tier is null or new.trust_tier = ' in v_def) > 0 THEN
    RAISE NOTICE 'migration 123: trigger already has CASE fix, skipping patch';
    RETURN;
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'migration 123: expected exactly 1 coalesce assign, found % — drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
  RAISE NOTICE 'migration 123: scan_memory_for_injection fixed to handle DEFAULT=unknown';
END
$patch$;

-- Verify the fix worked
DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'scan_memory_for_injection';

  IF position('when new.trust_tier is null or new.trust_tier = ' in v_def) = 0 THEN
    RAISE EXCEPTION 'migration 123: verification failed — CASE logic not found';
  END IF;

  RAISE NOTICE 'migration 123: verified — CASE logic present in trigger';
END
$verify$;
