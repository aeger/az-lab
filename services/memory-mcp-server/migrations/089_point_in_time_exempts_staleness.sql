-- Migration 089: make is_point_in_time authoritative for staleness, not just for the review queue.
--
-- WHY
--   087 introduced is_point_in_time and taught stale_memories_review_queue to skip
--   immutable dated logs. But it stopped at the view. memory_is_stale() -- the single
--   predicate 085 established -- never learned about the flag, so everything downstream
--   of the predicate still treats immutable history as stale:
--     * flag_stale_memories() re-sets staleness_candidate = true on them every night;
--     * is_stale_now() reports true, so recall applies STALE_CONFIDENCE_FACTOR (0.75x);
--     * the recall renderer appends a "+stale" label.
--   Measured before this migration: 335 rows stale, 334 of them is_point_in_time = true.
--   The queue read 1 while the recall path was still discounting 334 immutable logs.
--
--   That discount is not merely noisy, it is wrong. A research digest dated 2026-05-24
--   is exactly as true today as the day it was written. It is old, not low-confidence.
--   "Stale" here means "nobody has vouched for this claim lately" -- a record that makes
--   no standing claim cannot be stale, so the flag belongs in the predicate itself.
--
-- WHY the 5-arg overload (and no DEFAULT)
--   085's rule stands: memory_is_stale() is the ONE definition of staleness, do not
--   re-implement it anywhere. So the age/TTL logic stays put in the 4-arg form and the
--   5-arg form only adds the immutability short-circuit in front of it.
--   The 5th argument deliberately has NO DEFAULT: a defaulted overload alongside the
--   existing 4-arg function makes every 4-arg call ambiguous ("function is not unique")
--   and would break callers at runtime, not at migration time.
--
-- WHY NOT the dated-name regex (still no)
--   Unchanged from 087 -- see its header. supabase-key-rotation-2026-04-30 has a dated
--   name and documents where live credentials sit; its re-verification on 2026-07-27 is
--   what caught an un-shredded backup holding live R2/Anthropic/JWT secrets 88 days on.
--   A name regex would have silently suppressed that. Only an explicit write-time flag
--   is safe here.
--
-- BLAST RADIUS (approved by Jeff 2026-07-28)
--   334 immutable logs stop being served at 0.75x confidence with a +stale label.
--   Nothing gains a discount. No standing claim leaves the review queue: the queue was
--   already filtering on is_point_in_time, so its membership is unchanged by this
--   migration -- it just stops being the only thing that knows about the flag.

-- 1. predicate: immutability short-circuits staleness --------------------------
CREATE OR REPLACE FUNCTION public.memory_is_stale(
  p_type              text,
  p_verified_at       timestamptz,
  p_created_at        timestamptz,
  p_expires_at        timestamptz,
  p_is_point_in_time  boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- An immutable record makes no standing claim, so there is nothing to re-verify.
  -- Everything else delegates to the 4-arg rule -- one definition, per migration 085.
  SELECT CASE
    WHEN COALESCE(p_is_point_in_time, false) THEN false
    ELSE public.memory_is_stale(p_type, p_verified_at, p_created_at, p_expires_at)
  END;
$function$;

COMMENT ON FUNCTION public.memory_is_stale(text, timestamptz, timestamptz, timestamptz, boolean) IS
  'Staleness including the migration-087 immutability flag. Prefer this form everywhere; '
  'the 4-arg form is the age/TTL rule alone and is kept only as its implementation.';

GRANT EXECUTE ON FUNCTION public.memory_is_stale(text, timestamptz, timestamptz, timestamptz, boolean)
  TO postgres, authenticated, service_role;

-- 2. recall path: the computed column recall actually reads --------------------
-- src/index.ts reads is_stale_now for the confidence haircut and (as of this change)
-- for the +stale label. Teaching it the flag here is what removes the 0.75x discount
-- from immutable history.
CREATE OR REPLACE FUNCTION public.is_stale_now(m memories)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT public.memory_is_stale(m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time);
$function$;

-- 3. nightly sweep -------------------------------------------------------------
-- Without this the sweep would re-set staleness_candidate = true on immutable rows
-- every night and the cache would permanently disagree with is_stale_now.
CREATE OR REPLACE FUNCTION public.flag_stale_memories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  flagged_count integer;
BEGIN
  UPDATE memories m
  SET staleness_candidate = public.memory_is_stale(
        m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time)
  WHERE COALESCE(m.is_active, true) IS NOT FALSE
    AND COALESCE(m.staleness_candidate, false)
        IS DISTINCT FROM public.memory_is_stale(
              m.type, m.verified_at, m.created_at, m.expires_at, m.is_point_in_time);

  GET DIAGNOSTICS flagged_count = ROW_COUNT;
  RETURN flagged_count;
END;
$function$;

-- 4. queue: fold the exclusion into the predicate ------------------------------
-- 087 carried the exclusion as a separate WHERE term. Now that the predicate knows,
-- the separate term is redundant -- and a second place for the rule to drift from.
-- Column list unchanged so CREATE OR REPLACE preserves grants.
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
    AND memory_is_stale(type, verified_at, created_at, expires_at, is_point_in_time);

COMMENT ON VIEW public.stale_memories_review_queue IS
  'Standing-claim memories due re-verification. Immutable point-in-time records are '
  'excluded by memory_is_stale() itself as of migration 089 -- the view no longer '
  'carries its own copy of that rule.';

-- 5. close the grant leak 085 opened on this data ------------------------------
-- 085 revoked anon/authenticated on stale_memories_review_queue (a security-definer
-- view over memories, so those roles could read memory names through it). 087 then
-- created memory_review_headline over that same view and it inherited the blanket
-- default grants, handing the counts straight back to anon. Only the MCP server reads
-- it, over service_role -- confirmed no dashboard or client consumer.
REVOKE ALL ON public.memory_review_headline FROM anon, authenticated;
