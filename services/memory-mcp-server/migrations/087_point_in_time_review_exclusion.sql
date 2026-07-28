-- Migration 087: exclude immutable point-in-time logs from stale_memories_review_queue.
--
-- WHY
--   The "unverified" backlog read ~390 and never fell. Of 389 live queue rows,
--   386 were dated point-in-time records: daily research digests, triage/closeout
--   entries, Tech Breakthrough digests, dreaming summaries, incident write-ups.
--   Those are immutable history. They cannot drift, so re-verifying them is
--   meaningless -- and stamping verified_at to clear the queue would destroy the
--   exact signal verified_at exists to carry. Only memories making STANDING claims
--   about live lab state are worth verifying.
--
-- WHY NOT the obvious name-regex
--   Migration 083 already excludes dated journals from the contradiction detectors
--   via  name !~ '(\d{4}-\d{2}-\d{2}|(19|20)\d{6})'.  Reusing that predicate here
--   was measured and REJECTED: it is wrong in both directions for this queue.
--     - False exclusions (the dangerous kind): ha_vm_ram_bump_20260514,
--       cadvisor-cpu-cap-20260627, shelfmark-audiobook-download-config-20260627,
--       reference_agentbus_discord_2000_char_cap_20260723 all carry a date suffix
--       but assert LIVE config that can drift. A name regex would silently drop
--       them from review forever -- the opposite of this migration's goal.
--     - False inclusions: "AI Research Brief Mar 29 2026" spells its date in words
--       and slips through the regex entirely.
--   For 083 a false exclusion only costs a missed contradiction. Here it costs a
--   standing claim that is never re-verified again, so the bar is higher.
--
-- WHY NOT reuse lifecycle_pinned / memory_tier
--   Both are orthogonal to immutability. memory_tier is hot/warm/cold access
--   lifecycle (065); lifecycle_pinned is eviction protection (066). Overloading
--   either would conflate "don't evict this" with "don't verify this" -- different
--   questions with different answers. Hence an explicit dedicated flag.
--
-- METHOD
--   1. is_point_in_time flag, explicit and set at write time.
--   2. memory_is_log_series() mirrors COLLAPSE_RULES in
--      /home/almty1/claude/scripts/sync-memory.py -- the already-maintained
--      definition of "recurring dated log series". Kept deliberately CONSERVATIVE:
--      it matches only the recurring writer-generated series, which contain no
--      standing claims at all.
--   3. Backfill only those series (327 of 389 queue rows). The remaining 62 are
--      one-off dated work/incident records -- genuinely mixed, several assert live
--      config -- so they STAY in the queue as the real triage backlog and get
--      dispositioned one at a time by review. Non-destructive by construction:
--      nothing is auto-excluded unless it is provably a pure digest.
--   4. BEFORE INSERT trigger auto-flags new series writes, so the daily-research /
--      triage / dreaming / breakthrough writers inherit it without each being
--      edited. An explicit is_point_in_time on INSERT always wins.

-- 1. the flag ---------------------------------------------------------------
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS is_point_in_time boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.memories.is_point_in_time IS
  'True = immutable point-in-time record (dated digest, triage, incident write-up). '
  'Excluded from stale_memories_review_queue: its truth cannot drift, so re-verification '
  'is meaningless. Distinct from lifecycle_pinned (eviction) and memory_tier (access).';

-- 2. canonical series predicate ---------------------------------------------
-- Mirrors COLLAPSE_RULES in sync-memory.py. If a new recurring log series is added
-- there, add it here too.
CREATE OR REPLACE FUNCTION public.memory_is_log_series(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_name IS NULL THEN false ELSE (
    WITH s AS (
      SELECT trim(both '_' from
               regexp_replace(
                 regexp_replace(lower(p_name), '[''—–\-]', '', 'g'),
                 '[^a-z0-9]+', '_', 'g')) AS slug
    )
    SELECT slug ~ '^ai_memory_research_\d'
        OR slug ~ '^daily_selfimprovement_research_\d'
        OR slug ~ '^ai_research_20\d'
        OR slug ~ '^(research|daily).*(triage|review|closeout|synthesis)'
        OR slug ~ '^dailyaimemoryresearchtriage'
        OR slug ~ '^dreaming(_summary)?_'
        OR slug ~ '^weeklyref_'
        OR slug ~ 'tech_breakthrough'
        OR slug ~ '^constitutionaudit'
        OR slug ~ '^weeklyrlsaudit'
    FROM s
  ) END;
$function$;

COMMENT ON FUNCTION public.memory_is_log_series(text) IS
  'True for recurring dated log-series names (daily research, triage/closeout, dreaming, '
  'tech-breakthrough, weekly audits). Mirrors COLLAPSE_RULES in sync-memory.py. '
  'Deliberately conservative -- one-off dated incident records are NOT matched, because '
  'they often carry standing config claims that must stay reviewable.';

-- 3. backfill ---------------------------------------------------------------
UPDATE public.memories
   SET is_point_in_time = true
 WHERE is_point_in_time = false
   AND memory_is_log_series(name);

-- 4. auto-flag new series writes --------------------------------------------
CREATE OR REPLACE FUNCTION public.set_point_in_time_from_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only infer when the writer did not state it explicitly.
  IF NEW.is_point_in_time IS NOT TRUE AND memory_is_log_series(NEW.name) THEN
    NEW.is_point_in_time := true;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS memories_set_point_in_time_bi ON public.memories;
CREATE TRIGGER memories_set_point_in_time_bi
  BEFORE INSERT ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.set_point_in_time_from_name();

-- 5. re-scope the queue ------------------------------------------------------
-- Column list unchanged so CREATE OR REPLACE preserves existing grants.
CREATE OR REPLACE VIEW public.stale_memories_review_queue AS
 SELECT id,
    name,
    type,
    trust_tier,
    COALESCE(access_count, 0) AS access_count,
    verified_at,
    created_at,
    expires_at,
    now() - COALESCE(verified_at, created_at) AS unverified_for,
    verified_at IS NULL AS never_verified,
    row_number() OVER (ORDER BY (expires_at IS NOT NULL AND expires_at <= now()) DESC, (COALESCE(access_count, 0)) DESC, (COALESCE(verified_at, created_at))) AS review_rank
   FROM memories m
  WHERE COALESCE(is_active, true) IS NOT FALSE
    AND is_point_in_time = false
    AND memory_is_stale(type, verified_at, created_at, expires_at);

COMMENT ON VIEW public.stale_memories_review_queue IS
  'Standing-claim memories whose truth can actually change and are due re-verification. '
  'Immutable point-in-time records (is_point_in_time) are excluded -- see migration 087.';

CREATE INDEX IF NOT EXISTS idx_memories_point_in_time
  ON public.memories (is_point_in_time)
  WHERE is_point_in_time = false;

-- 6. headline metric ---------------------------------------------------------
-- Report THIS instead of the raw queue count. Migration 060 dropped the
-- access_count >= 10 gate, so the raw count is ~every project/reference row older
-- than 14 days (median access_count 0) -- a number that cannot be worked down.
CREATE OR REPLACE VIEW public.memory_review_headline AS
  SELECT
    (SELECT count(*) FROM stale_memories_review_queue)                AS standing_claims_unverified,
    (SELECT count(*) FROM stale_memories_review_queue
      WHERE never_verified)                                           AS never_verified,
    (SELECT count(*) FROM stale_memories_review_queue
      WHERE expires_at IS NOT NULL AND expires_at <= now())           AS expired,
    (SELECT count(*) FROM memories
      WHERE COALESCE(is_active, true) IS NOT FALSE
        AND is_point_in_time)                                         AS immutable_logs_excluded;

COMMENT ON VIEW public.memory_review_headline IS
  'Headline staleness metric. standing_claims_unverified is the actionable number; '
  'immutable_logs_excluded is the suppressed immutable-history population.';
