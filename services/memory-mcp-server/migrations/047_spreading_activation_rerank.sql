-- Migration 047: SYNAPSE-style spreading activation rerank
-- Source: 2026-06-15 daily research triage, REC1 (A-Mem / SYNAPSE link traversal)
--
-- Post-retrieval graph hop: given a hybrid_recall top-K result set, expand 1 hop via
-- memory_links and boost each candidate's score by the strength-weighted contribution
-- of its connected neighbours that also appear in the result set. Pure rerank — does
-- not introduce new candidates, so it composes with existing relevance/decay scoring.

CREATE OR REPLACE FUNCTION public.spreading_activation_rerank(
  p_ids              uuid[],
  p_scores           double precision[],
  p_link_weight      double precision DEFAULT 0.15,
  p_max_hops         integer          DEFAULT 1
)
RETURNS TABLE(memory_id uuid, original_score double precision, boost double precision, final_score double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  v_count := array_length(p_ids, 1);
  IF array_length(p_scores, 1) IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'spreading_activation_rerank: p_ids (%) and p_scores (%) length mismatch',
      v_count, array_length(p_scores, 1);
  END IF;

  IF p_max_hops < 1 OR p_max_hops > 2 THEN
    RAISE EXCEPTION 'spreading_activation_rerank: p_max_hops must be 1 or 2, got %', p_max_hops;
  END IF;

  RETURN QUERY
  WITH seeds AS (
    SELECT
      p_ids[i]    AS id,
      p_scores[i] AS score,
      i           AS rank_idx
    FROM generate_series(1, v_count) AS i
  ),
  -- Hop 1: any link between two seeds contributes (link_strength * neighbour_score) to each side.
  hop1 AS (
    SELECT s.id AS target, SUM(COALESCE(ml.strength, 0.5) * n.score) AS hop_boost
    FROM seeds s
    JOIN memory_links ml
      ON (ml.source_id = s.id OR ml.target_id = s.id)
    JOIN seeds n
      ON n.id = CASE WHEN ml.source_id = s.id THEN ml.target_id ELSE ml.source_id END
     AND n.id <> s.id
    GROUP BY s.id
  ),
  -- Hop 2 (optional): 2-hop neighbours that also appear in the seed set, decayed by 0.5.
  hop2 AS (
    SELECT s.id AS target,
           0.5 * SUM(COALESCE(ml1.strength, 0.5) * COALESCE(ml2.strength, 0.5) * n2.score) AS hop_boost
    FROM seeds s
    JOIN memory_links ml1
      ON (ml1.source_id = s.id OR ml1.target_id = s.id)
    JOIN memory_links ml2
      ON (
        ml2.source_id = CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END
        OR ml2.target_id = CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END
      )
    JOIN seeds n2
      ON n2.id = CASE WHEN ml2.source_id = (CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END)
                      THEN ml2.target_id ELSE ml2.source_id END
     AND n2.id <> s.id
     AND n2.id <> (CASE WHEN ml1.source_id = s.id THEN ml1.target_id ELSE ml1.source_id END)
    WHERE p_max_hops >= 2
    GROUP BY s.id
  ),
  boosts AS (
    SELECT target, SUM(hop_boost) AS total_boost
    FROM (
      SELECT target, hop_boost FROM hop1
      UNION ALL
      SELECT target, hop_boost FROM hop2
    ) u
    GROUP BY target
  )
  SELECT
    s.id                                                                       AS memory_id,
    s.score                                                                     AS original_score,
    (COALESCE(b.total_boost, 0) * p_link_weight)::double precision              AS boost,
    (s.score + COALESCE(b.total_boost, 0) * p_link_weight)::double precision    AS final_score
  FROM seeds s
  LEFT JOIN boosts b ON b.target = s.id
  ORDER BY 4 DESC, s.rank_idx ASC;
END;
$function$;

COMMENT ON FUNCTION public.spreading_activation_rerank(uuid[], double precision[], double precision, integer)
IS 'SYNAPSE/A-Mem post-retrieval rerank: given a top-K id+score set from hybrid_recall, applies 1-2 hop link traversal via memory_links to boost seeds linked to other seeds. Pure rerank, no new candidates. Migration 047, 2026-06-15.';

GRANT EXECUTE ON FUNCTION public.spreading_activation_rerank(uuid[], double precision[], double precision, integer) TO authenticated, anon, service_role;
