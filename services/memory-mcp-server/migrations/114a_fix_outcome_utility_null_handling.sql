-- Migration 114a: fix NULL handling in refresh_memory_outcome_utility()
--
-- BUG SHIPPED IN 114. The LEFT JOIN in refresh_memory_outcome_utility() leaves
-- cc.n NULL for any memory with no consult edges, and the expression was:
--
--     COALESCE(LEAST(LN(1.0 + cc.n::float) / LN(21.0), 1.0), 0.0)
--
-- Postgres LEAST/GREATEST IGNORE NULL arguments rather than propagating them —
-- unlike nearly every other function, and unlike the C-family intuition the code
-- was written with. So LEAST(NULL, 1.0) returns 1.0, not NULL, the outer COALESCE
-- never fired, and all 1036 rows were stamped outcome_utility = 1.0: the full
-- 0.15 bonus awarded on zero evidence.
--
-- HOW IT WAS CAUGHT: the post-migration verification in 114's own footer.
--   SELECT count(*) FROM memories WHERE outcome_utility > 0;
-- returned 1036 where 0 was the predicted value (no episode has ever populated
-- memories_consulted). The prediction is what made the bug visible — a check that
-- only asserted "no errors" would have passed.
--
-- BLAST RADIUS: none reached the retention path. The utility term is a strictly
-- non-negative bonus, so the monotone guarantee held throughout: the regression
-- probe returned 0 rows scoring below their 4-term base, and prune_decayed_memories
-- would still have deleted 0 rows at defaults. The damage was that the signal was
-- uniform, and therefore carried no information, for the minutes between 114 and 114a.
--
-- FIX: coalesce the COUNT, not the result. LN(1.0 + 0) / LN(21.0) = 0 naturally,
-- so the outer COALESCE is not needed at all.
--
-- The corrected form is also folded back into 114's file, so a fresh replay of the
-- migration series is right the first time and this file becomes an idempotent no-op.

CREATE OR REPLACE FUNCTION public.refresh_memory_outcome_utility()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE updated_count integer;
BEGIN
  WITH consult_counts AS (
    SELECT c.memory_id, count(*) AS n
    FROM agent_episodes e
    CROSS JOIN LATERAL unnest(e.memories_consulted) AS c(memory_id)
    WHERE e.status = 'completed'
      AND e.memories_consulted IS NOT NULL
    GROUP BY c.memory_id
  ), scored AS (
    SELECT m.id,
           -- COALESCE the count, NOT the LEAST() result. n=0 -> LN(1)/LN(21) = 0.
           LEAST(LN(1.0 + COALESCE(cc.n, 0)::float) / LN(21.0), 1.0) AS util
    FROM memories m
    LEFT JOIN consult_counts cc ON cc.memory_id = m.id
  )
  UPDATE memories m
  SET outcome_utility = s.util
  FROM scored s
  WHERE m.id = s.id
    AND m.outcome_utility IS DISTINCT FROM s.util;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refresh_memory_outcome_utility TO service_role;

-- Repair the rows 114 mis-stamped.
SELECT public.refresh_memory_outcome_utility();

-- ─── Verification (run after applying) ───────────────────────────────────────
--   SELECT count(*) FILTER (WHERE outcome_utility > 0) AS with_utility,
--          count(*) FILTER (WHERE outcome_utility = 0) AS zero_utility
--   FROM memories;
-- Expected today: with_utility = 0, zero_utility = every row. with_utility should
-- only start climbing once memory-mcp v5.16.0 has accrued consult edges.
