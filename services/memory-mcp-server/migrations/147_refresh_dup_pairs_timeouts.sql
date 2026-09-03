-- 147: raise the timeouts on refresh_memory_duplicate_pairs()
-- Applied to azlab-memory as migration 20260903004351.
--
-- memory_duplicate_pairs is an O(n^2) threshold self-join (memories a JOIN
-- memories b ON a.id < b.id AND (a.embedding <=> b.embedding) < 0.08) that no
-- index can serve. At 1103 active 768-dim rows the REFRESH measures ~7.3s and
-- grows with the SQUARE of the corpus, while the timeout is flat.
--
-- service_role.rolconfig is NULL, so it inherits statement_timeout=8s AND
-- lock_timeout=8s from authenticator. On 2026-09-02 04:10:09Z the refresh
-- finally crossed 8s and memory-lifecycle-pass.service died at its FIRST call
-- (HTTP 500 from /rest/v1/rpc/refresh_memory_duplicate_pairs), so no stage of
-- the nightly pass ran at all.
--
-- Non-concurrent REFRESH also takes ACCESS EXCLUSIVE, so lock_timeout was a
-- second ceiling on the same path; both are raised here.
--
-- 90s sits under the caller's 120s httpx timeout so the server still loses the
-- race first and returns a real error instead of the client hanging up.
-- Semantics are unchanged: same matview, same 0.08 threshold, same pair count.
CREATE OR REPLACE FUNCTION public.refresh_memory_duplicate_pairs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90s'
 SET lock_timeout TO '30s'
AS $function$
DECLARE n integer;
BEGIN
  REFRESH MATERIALIZED VIEW public.memory_duplicate_pairs;
  SELECT count(*) INTO n FROM public.memory_duplicate_pairs;
  RETURN n;
END;
$function$;
