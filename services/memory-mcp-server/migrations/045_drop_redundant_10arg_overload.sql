-- Migration 045: drop the redundant 10-arg hybrid_recall overload
--
-- The 11-arg entity_linking overload from migration 039 (and re-CREATEd with
-- Weibull decay in migration 044) is a STRICT SUPERSET of the 10-arg topic_hint
-- overload from migration 036 (re-CREATEd with Weibull decay in migration 043):
-- the only extra arg is `p_query_entities text[] DEFAULT NULL`. Auto-extraction
-- happens inside the function body when callers don't pass entities, so the
-- 11-arg variant behaves identically to the 10-arg variant for those callers.
--
-- Keeping both overloads caused PostgreSQL's named-arg dispatch to error
-- "function ... is not unique" any time fewer than 11 args were supplied —
-- which is every production RPC call from src/index.ts (none pass entities).
-- Production happened to keep working because PostgREST's tiebreaker picked one;
-- removing the redundant overload eliminates the latent fragility.

DROP FUNCTION IF EXISTS public.hybrid_recall(text, text, float, int, text, text, text, float, text, text);

-- Sentinel
CREATE OR REPLACE FUNCTION public.apply_drop_10arg_overload_if_present()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';
  IF v_count > 1 THEN
    RETURN format('hybrid_recall has %s overloads — expected exactly 1 after migration 045', v_count);
  END IF;
  RETURN '10-arg redundant overload dropped';
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_drop_10arg_overload_if_present() TO service_role;
