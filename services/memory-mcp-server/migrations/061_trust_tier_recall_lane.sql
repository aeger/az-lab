-- Migration 061: wire trust_tier into the recall scoring path
--
-- WHY (audited live 2026-07-21):
--   trust_tier is populated on 763/763 active rows (high 483, unknown 259, medium 21)
--   and read by NOTHING. `grep -rn trust_tier src/` returns zero hits; `grep -rni
--   quarantine src/ migrations/` returns zero hits. We pay to compute and store a
--   trust signal on every write and then rank recall without it.
--
--   2026 memory-security literature (A-MemGuard arXiv 2510.02373, MemGuard
--   ac12644/MemGuard, OWASP ASI06) converges on trust-scored retrieval as the
--   baseline defense against memory poisoning: down-weight low-trust records at
--   fusion time so a poisoned or unvouched memory has to clear a higher relevance
--   bar to be served. This converts 763 rows of dead metadata into an active lane.
--
-- SOFT WEIGHT, NOT A HARD FILTER — deliberately.
--   259 rows (34%) are trust_tier='unknown'. Those are overwhelmingly un-triaged,
--   not untrustworthy. A MemGuard-style hard quarantine threshold applied today
--   would silently drop a third of the corpus out of recall and tank quality.
--   So 061 ships the down-weighting lane ONLY. The 'low' and 'quarantined' arms
--   below are defined but currently match zero rows — they are the landing zone
--   for a future hard filter, to be enabled only AFTER the 259 unknown rows are
--   triaged into high/medium.
--
-- WHY A DO BLOCK INSTEAD OF A LITERAL CREATE OR REPLACE:
--   hybrid_recall's body is ~250 lines accreted across migrations 017/035/045/056/059
--   (6 RRF lanes, and the whole scoring block appears TWICE — once to select
--   result_ids, once in the RETURN QUERY). Hand-copying it into this file to change
--   two expressions would be the higher-risk operation: any transcription slip
--   silently changes retrieval, and the two copies must stay byte-identical or
--   selection and output orderings diverge. Patching the deployed definition in
--   place guarantees both copies get the same edit. Guarded so re-running is a
--   no-op rather than stacking the multiplier twice.

-- 1. The trust lane itself, factored out so it is greppable and tunable in one place.
CREATE OR REPLACE FUNCTION public.trust_weight(p_tier text)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE COALESCE(p_tier, 'unknown')
    WHEN 'high'        THEN 1.00
    WHEN 'medium'      THEN 0.95
    WHEN 'unknown'     THEN 0.90  -- 259 rows: un-triaged, not distrusted. Gentle nudge only.
    WHEN 'low'         THEN 0.75  -- currently 0 rows
    WHEN 'quarantined' THEN 0.40  -- currently 0 rows; reserved for post-triage hard tier
    ELSE 0.90
  END::double precision
$$;

COMMENT ON FUNCTION public.trust_weight(text) IS
  'Multiplicative trust factor applied to hybrid_recall composite scores (migration 061). Monotone in trust: high=1.00 down to quarantined=0.40. Tune the recall trust policy HERE — it is referenced by both scoring copies inside hybrid_recall. Soft down-weight only; no hard filtering until the unknown-tier backlog is triaged.';

-- 2. Multiply the A-MAC composite by the trust factor in BOTH scoring copies.
DO $patch$
DECLARE
  v_def text;
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'hybrid_recall not found — cannot apply trust lane';
  END IF;

  -- Idempotency guard: bail out if the lane is already wired, otherwise a second
  -- run would match the patched text again and square the multiplier.
  IF position('trust_weight' in v_def) > 0 THEN
    RAISE NOTICE 'migration 061: trust lane already present, skipping patch';
    RETURN;
  END IF;

  -- Both copies end their composite with the identical token `)::float AS hybrid_score,`.
  v_hits := (length(v_def) - length(replace(v_def, ')::float AS hybrid_score,', '')))
            / length(')::float AS hybrid_score,');
  IF v_hits <> 2 THEN
    RAISE EXCEPTION
      'migration 061: expected exactly 2 hybrid_score scoring sites, found % — hybrid_recall has drifted, patch aborted', v_hits;
  END IF;

  v_def := replace(
    v_def,
    ')::float AS hybrid_score,',
    ')::float * public.trust_weight(m.trust_tier) AS hybrid_score,');

  EXECUTE v_def;
  RAISE NOTICE 'migration 061: trust lane wired into both hybrid_recall scoring sites';
END
$patch$;

REVOKE EXECUTE ON FUNCTION public.trust_weight(text) FROM anon;
