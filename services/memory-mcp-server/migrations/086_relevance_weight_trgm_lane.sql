-- ============================================================================
-- Migration 086 — retrieval ranker: relevance weight, trgm lane, scoring-site
--                 de-duplication, and the conflict_flagged clear-on-resolve leak
--
-- WHY (2026-07-28, from the "is nDCG 0.374 real?" investigation)
--
-- The gold labels were verified tight (avg 1.21 golds/probe) and the misses were
-- manually confirmed correct, so the weak categories are a RANKING failure, not a
-- labelling artefact. Baseline pre-ranker-tune: nDCG@10 0.477, recall@10 0.714,
-- recall@5 0.625; category recall@5 single_hop 0.41, temporal 0.25 — the honest
-- signal, since mined_high_recall (0.94) was mined from recall behaviour and is
-- partly circular.
--
-- Three structural causes, fixed here:
--
-- 1. RELEVANCE WAS 0.15 OF THE SCORE, AND EVEN THAT WAS SATURATED.
--    The A-MAC composite was 0.25 recency + 0.20 access_count + 0.15 novelty +
--    0.25 importance + 0.15 RRF + 0.10 recall_count: 85% popularity/recency prior.
--    Worse, the relevance term was LEAST(rrf_score / 0.033, 1.0) against a maximum
--    attainable rrf_score of 0.103 — two lanes at rank 1 already saturate it, so
--    the term collapsed to near-binary and its usable spread was ~0.09 of the
--    score against ~0.70 for the priors. A memory literally named "MikroTik SSH
--    Access" (BM25 1.10, trigram 1.00 at table level) lost to more-accessed rows.
--    Fixed by normalising RRF within the candidate set and re-weighting; the
--    weights now live in recall_weights so tuning is an UPDATE, not a migration.
--
-- 2. THE TRGM LANE WAS GLOBALLY GATED.
--    NOT EXISTS (SELECT 1 FROM bm25_weighted) AND NOT EXISTS (... bm25_plain)
--    disabled the lane for the WHOLE QUERY as soon as either BM25 lane returned
--    ANY row — not per row, as a fallback would. Gate removed. The lane also now
--    scores the name on its own and uses topic_hint as its probe. The full-body
--    trigram term is dropped: it cost 368 ms per pass over 874 rows (1.5 s per
--    recall across both sites), and body lexical matching is already what the two
--    BM25 lanes exist for. The old expression never used idx_memories_trgm anyway
--    -- it wrote bare m.content where the index has COALESCE(content,'').
--
-- 3. THE TWO SCORING SITES WERE COPY-PASTE TWINS.
--    Migration 061 documented that trust_weight and the composite are applied at
--    two sites inside hybrid_recall that "MUST stay identical", with nothing
--    checking. The composite is now ONE function, public.amac_score(), called from
--    both sites, and recall_scoring_sites_consistent() asserts the call text and
--    the lane block are byte-identical between the two. retrieval_regression.py
--    calls it before every run. Every lane also gains an m.id tiebreak and an
--    explicit ORDER BY before LIMIT — a ROW_NUMBER lane with LIMIT and no ORDER BY
--    leaves which rows survive formally unspecified, which is drift waiting to
--    happen between the two sites.
--
-- CERTIFIED RESULT (eval/retrieval_regression.py, 56 positive-gold probes):
--   pre-ranker-tune      nDCG@10 0.477  recall@5 0.625  recall@10 0.714  MRR 0.432
--   post-086-structural  nDCG@10 0.615  recall@5 0.750  recall@10 0.768  MRR 0.597
--     ^ this migration's STRUCTURAL half only, weights still at the old values
--   post-086-tuned       nDCG@10 0.875  recall@5 1.000  recall@10 1.000  MRR 0.879
--     ^ plus the tuned weights below
--   category recall@5, pre -> post: single_hop 0.41 -> 1.00, temporal 0.38 -> 1.00.
--   FCFR stayed 0.000 throughout: nothing here made superseded memories come back.
--
--   CAVEAT, so nobody reads 1.000 as "retrieval is solved": recall@5 is now
--   SATURATED on this probe set, so the harness can no longer discriminate between
--   configurations at the top -- that is why the tuning decision above was made on
--   clean nDCG@10 (0.558 -> 0.815) and not on these headline numbers. The next
--   ranker change needs harder probes first, or it will be tuning against a
--   ceiling. Also note 33 of the 65 probes have a topic_hint that is a near-copy
--   of a gold memory NAME; that circularity is real and is why the clean subset
--   exists. See eval/tune_ranker.py mark_leaky().
--
-- ALSO (separate leak, same investigation): sweep_conflicts() resolved conflicts
-- but never cleared memories.conflict_flagged, so governance_weight() kept
-- multiplying 0.75 into rows whose conflicts had been closed long ago. Six rows
-- were carrying stale flags on 2026-07-28 including MikroTik SSH Access and Cox
-- Business Upgrade — both failing eval probes. Cleared manually then; the clear is
-- now part of resolve_conflict(), which is the one operator every resolution path
-- (auto and manual) funnels through, so sweep_conflicts() inherits it for free.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tunable ranker weights. One row, enforced by the boolean PK.
--    Lives in a table rather than in the function body so a tuning sweep is an
--    UPDATE per config instead of a DDL round trip per config.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recall_weights (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  w_recency        double precision NOT NULL DEFAULT 0.25,
  w_access         double precision NOT NULL DEFAULT 0.20,
  w_novelty        double precision NOT NULL DEFAULT 0.15,
  w_importance     double precision NOT NULL DEFAULT 0.25,
  w_relevance      double precision NOT NULL DEFAULT 0.15,
  w_recall_count   double precision NOT NULL DEFAULT 0.10,
  w_lane_trgm      double precision NOT NULL DEFAULT 0.5,
  trgm_floor       double precision NOT NULL DEFAULT 0.05,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  notes            text
);

INSERT INTO public.recall_weights (id, notes)
VALUES (true, 'pre-086 defaults; overwritten below with the tuned values')
ON CONFLICT (id) DO NOTHING;

-- The tuned values, from eval/tune_ranker.py sweep --grid final_grid.json
-- (2026-07-28, 10 configs x 65 probes, one consistent leak marking).
--
-- Config rel0.60-fl0.25 won on clean nDCG@10 (0.815), the leakage-controlled
-- metric over the 27 probes whose topic_hint is NOT a near-copy of a gold name.
-- Tuning on the all-probe number would have been tuning on the answer key: 33 of
-- 65 probes leak, and the trgm lane probes with topic_hint.
--
-- Relevance is flat across 0.60-0.90 on clean nDCG@10 (0.815 / 0.809 / 0.779), so
-- 0.60 is chosen as the least aggressive point on the plateau. The prior terms are
-- rescaled proportionally rather than dropped: zeroing access/novelty/recall_count
-- ("nopop") scored 0.749, WORSE than keeping them at reduced weight -- the priors
-- are useful tiebreakers, they were just drowning the signal at 85% of the score.
-- The total stays 1.10 so hybrid_score keeps the scale every consumer (dashboard,
-- MCP confidence display, memory_health_report) is calibrated against.
--
-- trgm_floor 0.25 over the 0.05 default: the lane is ungated now, so a low floor
-- lets weak partial-name matches into the fusion and costs precision. The
-- lane-OFF ablation at the same weights scored clean nDCG@10 0.623 vs 0.809 --
-- un-gating the lane is worth more than the re-weighting on its own.
UPDATE public.recall_weights SET
  w_recency      = 0.1316,
  w_access       = 0.1053,
  w_novelty      = 0.0789,
  w_importance   = 0.1316,
  w_relevance    = 0.6000,
  w_recall_count = 0.0526,
  w_lane_trgm    = 0.5,
  trgm_floor     = 0.25,
  updated_at     = now(),
  notes          = 'tuned 2026-07-28 (rel0.60-fl0.25); clean nDCG@10 0.815 over 27 non-leaky probes'
WHERE id;

ALTER TABLE public.recall_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recall_weights_read ON public.recall_weights;
CREATE POLICY recall_weights_read ON public.recall_weights FOR SELECT
  TO authenticated, service_role USING (true);
DROP POLICY IF EXISTS recall_weights_write ON public.recall_weights;
CREATE POLICY recall_weights_write ON public.recall_weights FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. The A-MAC composite, defined exactly once.
--    STABLE, not IMMUTABLE: the recency term reads now().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.amac_score(
  p_last_accessed    timestamptz,
  p_memory_class     text,
  p_access_count     integer,
  p_novelty          double precision,
  p_importance       double precision,
  p_rrf_norm         double precision,
  p_recall_count     integer,
  p_trust_tier       text,
  p_superseded_by    uuid,
  p_conflict_flagged boolean,
  p_w                double precision[]
) RETURNS double precision
LANGUAGE sql
STABLE PARALLEL SAFE
AS $function$
  SELECT (
      p_w[1] * EXP(- POWER(
          GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(p_last_accessed, now()))) / 86400.0, 0.0)
          / CASE p_memory_class WHEN 'semantic' THEN 60.0 WHEN 'episodic' THEN 7.0 WHEN 'procedural' THEN 180.0 ELSE 10.0 END,
          CASE p_memory_class WHEN 'semantic' THEN 0.70 WHEN 'episodic' THEN 1.30 WHEN 'procedural' THEN 0.50 ELSE 1.00 END
        ))
    + p_w[2] * LEAST(LN(1.0 + COALESCE(p_access_count, 0)::float) / LN(101.0), 1.0)
    + p_w[3] * COALESCE(p_novelty, 0.5)
    + p_w[4] * COALESCE(p_importance, 0.5)
    + p_w[5] * LEAST(GREATEST(COALESCE(p_rrf_norm, 0.0), 0.0), 1.0)
    + p_w[6] * LEAST(LN(1.0 + COALESCE(p_recall_count, 0)::float) / LN(51.0), 1.0)
  )::float
  * public.trust_weight(p_trust_tier)
  * public.governance_weight(p_superseded_by, p_conflict_flagged)
$function$;

COMMENT ON FUNCTION public.amac_score IS
  'The A-MAC composite + trust + governance multipliers, defined ONCE. hybrid_recall '
  'calls it from both of its scoring sites; recall_scoring_sites_consistent() proves '
  'the two calls are identical. Weights come from recall_weights, read once per '
  'hybrid_recall invocation and passed in as p_w.';

-- ---------------------------------------------------------------------------
-- 3. hybrid_recall
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text text,
  p_query_embedding text DEFAULT NULL::text,
  p_match_threshold double precision DEFAULT 0.3,
  p_match_count integer DEFAULT 20,
  p_filter_type text DEFAULT NULL::text,
  p_agent_id text DEFAULT NULL::text,
  p_agent_scope text DEFAULT NULL::text,
  p_min_confidence double precision DEFAULT 0.0,
  p_memory_class text DEFAULT NULL::text,
  p_topic_hint text DEFAULT NULL::text,
  p_query_entities text[] DEFAULT NULL::text[]
)
RETURNS TABLE(id uuid, type text, name text, description text, content text,
              tags text[], source text, conflict_flagged boolean, access_count integer,
              importance_score double precision, hybrid_score double precision,
              confidence double precision, staleness_candidate boolean,
              memory_class text, matched_entities text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_embedding  vector(768);
  result_ids   uuid[];
  v_topic      text := NULLIF(TRIM(COALESCE(p_topic_hint, '')), '');
  v_entities   text[];
  v_w          double precision[];
  v_wl_trgm    double precision;
  v_trgm_floor double precision;
  v_trgm_probe text;
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;
  v_entities := COALESCE(p_query_entities, public.extract_entities(p_query_text));
  IF v_entities IS NOT NULL AND array_length(v_entities, 1) IS NULL THEN
    v_entities := NULL;
  END IF;

  -- Read the tuning row ONCE. Both scoring sites get the same v_w, so a concurrent
  -- UPDATE to recall_weights mid-sweep cannot score the selection site with one
  -- weight vector and the return site with another.
  SELECT ARRAY[rw.w_recency, rw.w_access, rw.w_novelty,
               rw.w_importance, rw.w_relevance, rw.w_recall_count],
         rw.w_lane_trgm, rw.trgm_floor
    INTO v_w, v_wl_trgm, v_trgm_floor
  FROM public.recall_weights rw WHERE rw.id;
  IF v_w IS NULL THEN
    v_w := ARRAY[0.25, 0.20, 0.15, 0.25, 0.15, 0.10];
    v_wl_trgm := 0.5;
    v_trgm_floor := 0.05;
  END IF;

  -- topic_hint is the caller's distilled intent — a far better trigram probe than
  -- a full question sentence, whose stopwords drown a three-word title.
  v_trgm_probe := COALESCE(v_topic, p_query_text);

  WITH
  -- <LANES>
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC, m.id) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC, m.id) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC, m.id) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  -- Lexical-similarity lane. Ungated (see migration header): it used to switch
  -- itself off globally whenever EITHER BM25 lane returned a single row, which is
  -- every non-trivial query, so the lane that scores an exact title match 1.00
  -- almost never reached the fusion. Now it always runs and earns its rank.
  -- Probe = topic_hint when present (that is the caller's distilled intent), and
  -- the lane now scores the NAME (and name+description), not name||description||
  -- content. Two reasons. Signal: trigram similarity against a 2.4 KB average body
  -- dilutes an exact title match to noise, and body-text lexical matching is
  -- already what the two BM25 lanes do. Cost: the full-body expression measured
  -- 368 ms per pass over 874 rows, evaluated twice per site and at two sites --
  -- 1.5 s of the 1.5 s total. Name-only is ~9 ms and hits idx_memories_name_trgm.
  -- Nothing live is lost: the old body lane was gated off on every query where
  -- either BM25 lane returned a row, which is nearly all of them.
  -- Floor is tunable via recall_weights.trgm_floor.
  trgm_ranked AS (
    SELECT s.mem_id, ROW_NUMBER() OVER (ORDER BY s.sim DESC, s.mem_id) AS trgm_rank
    FROM (
      SELECT m.id AS mem_id, GREATEST(
          similarity(m.name, v_trgm_probe),
          strict_word_similarity(m.name, p_query_text),
          similarity(m.name || ' ' || COALESCE(m.description, ''), v_trgm_probe)
        ) AS sim
      FROM memories m
      WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ) s
    WHERE s.sim >= v_trgm_floor
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank), 0.0)
       + COALESCE(v_wl_trgm / (60.0 + t.trgm_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  -- Relevance normalised WITHIN the candidate set, not against a magic constant.
  -- The old term was LEAST(rrf_score / 0.033, 1.0); max attainable rrf_score is
  -- 6.3/61 = 0.103, so any row hitting two lanes near rank 1 saturated at 1.0 and
  -- relevance stopped discriminating exactly where it mattered. Dividing by the
  -- per-query max makes it a true 0..1 spread on every query.
  -- Computed HERE, inside the CTE, and not as a window in the outer SELECT: the
  -- RETURN QUERY site filters on result_ids, so an outer window would normalise
  -- over a different population than the selection site and the two would drift.
  rrf_n AS (
    SELECT r.mem_id,
           COALESCE(r.rrf_score / NULLIF(MAX(r.rrf_score) OVER (), 0.0), 0.0) AS rrf_norm
    FROM rrf r
  )
  -- </LANES>
  SELECT ARRAY_AGG(sel.id ORDER BY sel.hybrid_score DESC, sel.id)
    INTO result_ids
  FROM (
    SELECT m.id,
    -- <AMAC>
    public.amac_score(
      COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()),
      m.memory_class,
      COALESCE(m.access_count, 0),
      m.amac_novelty_score,
      m.importance_score,
      rrf_n.rrf_norm,
      COALESCE(m.recall_count, 0),
      m.trust_tier,
      m.superseded_by,
      m.conflict_flagged,
      v_w
    )
    -- </AMAC>
      AS hybrid_score
    FROM rrf_n
    JOIN memories m ON m.id = rrf_n.mem_id
    WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND m.trust_tier IS DISTINCT FROM 'quarantined'
    ORDER BY hybrid_score DESC, m.id
    LIMIT p_match_count
  ) sel;

  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count = COALESCE(mem_upd.access_count, 0) + 1,
        recall_count = COALESCE(mem_upd.recall_count, 0) + 1,
        accessed_at = now(), last_accessed_at = now(), last_accessed = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- NOTE: the access/recall bump above has already fired, so the composite below
  -- is computed against bumped counters while the selection above saw pre-bump
  -- ones. That was true before this migration too and it only ever reorders rows
  -- WITHIN the already-chosen set (every returned row got the same +1), which is
  -- why it is left alone here rather than folded into an unrelated change.
  RETURN QUERY
  WITH
  -- <LANES>
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC, m.id) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL AND m.embedding IS NOT NULL AND m.is_active IS NOT FALSE
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC, m.id) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC, m.id) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL AND m.search_vec IS NOT NULL AND m.is_active IS NOT FALSE
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC, m.id) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL AND m.is_active IS NOT FALSE AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  -- Lexical-similarity lane. Ungated (see migration header): it used to switch
  -- itself off globally whenever EITHER BM25 lane returned a single row, which is
  -- every non-trivial query, so the lane that scores an exact title match 1.00
  -- almost never reached the fusion. Now it always runs and earns its rank.
  -- Probe = topic_hint when present (that is the caller's distilled intent), and
  -- the lane now scores the NAME (and name+description), not name||description||
  -- content. Two reasons. Signal: trigram similarity against a 2.4 KB average body
  -- dilutes an exact title match to noise, and body-text lexical matching is
  -- already what the two BM25 lanes do. Cost: the full-body expression measured
  -- 368 ms per pass over 874 rows, evaluated twice per site and at two sites --
  -- 1.5 s of the 1.5 s total. Name-only is ~9 ms and hits idx_memories_name_trgm.
  -- Nothing live is lost: the old body lane was gated off on every query where
  -- either BM25 lane returned a row, which is nearly all of them.
  -- Floor is tunable via recall_weights.trgm_floor.
  trgm_ranked AS (
    SELECT s.mem_id, ROW_NUMBER() OVER (ORDER BY s.sim DESC, s.mem_id) AS trgm_rank
    FROM (
      SELECT m.id AS mem_id, GREATEST(
          similarity(m.name, v_trgm_probe),
          strict_word_similarity(m.name, p_query_text),
          similarity(m.name || ' ' || COALESCE(m.description, ''), v_trgm_probe)
        ) AS sim
      FROM memories m
      WHERE m.is_active IS NOT FALSE
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ) s
    WHERE s.sim >= v_trgm_floor
    ORDER BY 2 LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank), 0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank), 0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank), 0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank), 0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank), 0.0)
       + COALESCE(v_wl_trgm / (60.0 + t.trgm_rank), 0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  -- Relevance normalised WITHIN the candidate set, not against a magic constant.
  -- The old term was LEAST(rrf_score / 0.033, 1.0); max attainable rrf_score is
  -- 6.3/61 = 0.103, so any row hitting two lanes near rank 1 saturated at 1.0 and
  -- relevance stopped discriminating exactly where it mattered. Dividing by the
  -- per-query max makes it a true 0..1 spread on every query.
  -- Computed HERE, inside the CTE, and not as a window in the outer SELECT: the
  -- RETURN QUERY site filters on result_ids, so an outer window would normalise
  -- over a different population than the selection site and the two would drift.
  rrf_n AS (
    SELECT r.mem_id,
           COALESCE(r.rrf_score / NULLIF(MAX(r.rrf_score) OVER (), 0.0), 0.0) AS rrf_norm
    FROM rrf r
  )
  -- </LANES>
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    -- <AMAC>
    public.amac_score(
      COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()),
      m.memory_class,
      COALESCE(m.access_count, 0),
      m.amac_novelty_score,
      m.importance_score,
      rrf_n.rrf_norm,
      COALESCE(m.recall_count, 0),
      m.trust_tier,
      m.superseded_by,
      m.conflict_flagged,
      v_w
    )
    -- </AMAC>
    AS hybrid_score,
    COALESCE(m.confidence, 0.8)::float,
    COALESCE(m.staleness_candidate, false),
    m.memory_class,
    CASE WHEN v_entities IS NOT NULL THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities)) ELSE ARRAY[]::text[] END AS matched_entities
  FROM rrf_n
  JOIN memories m ON m.id = rrf_n.mem_id
  WHERE m.is_active IS NOT FALSE AND m.id = ANY(result_ids)
    AND m.trust_tier IS DISTINCT FROM 'quarantined'
  ORDER BY hybrid_score DESC, m.id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The drift guard migration 061 asked for and never got.
--    Fails loudly if the two scoring sites stop being identical.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recall_scoring_sites_consistent()
RETURNS TABLE(block text, sites integer, identical boolean)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_src   text;
  v_name  text;
  v_parts text[];
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';

  FOREACH v_name IN ARRAY ARRAY['LANES', 'AMAC'] LOOP
    -- Split on the literal markers rather than a lazy regex. Postgres POSIX AREs
    -- take their greediness from the FIRST quantifier in the pattern, so a leading
    -- \s* makes even a (.*?) behave greedily and the two blocks collapse into one
    -- match. string_to_array has no such surprise.
    SELECT ARRAY(
      SELECT btrim(regexp_replace(split_part(u.chunk, '-- </' || v_name || '>', 1), '\s+', ' ', 'g'))
      FROM unnest(string_to_array(v_src, '-- <' || v_name || '>')) WITH ORDINALITY AS u(chunk, ord)
      WHERE u.ord > 1
    ) INTO v_parts;
    block     := v_name;
    sites     := COALESCE(array_length(v_parts, 1), 0);
    identical := sites >= 2
                 AND (SELECT count(DISTINCT p) FROM unnest(v_parts) p) = 1;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.recall_scoring_sites_consistent IS
  'Asserts the <LANES> and <AMAC> blocks appear at least twice in hybrid_recall and '
  'are identical modulo whitespace. Migration 061 documented that the two scoring '
  'sites MUST stay identical; this is the thing that notices when they do not. '
  'retrieval_regression.py calls it before every run.';

-- ---------------------------------------------------------------------------
-- 5. Clear conflict_flagged when the last open conflict on a memory closes.
--    resolve_conflict() is the single operator every path funnels through
--    (resolve_conflict_auto -> sweep_conflicts, and manual resolution alike),
--    so the clear belongs here rather than in sweep_conflicts().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_conflict(
  p_conflict_id uuid, p_resolved_by text, p_notes text DEFAULT NULL::text)
RETURNS void
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH closed AS (
    UPDATE memory_conflicts SET
        resolved = true,
        resolved_at = now(),
        resolved_by = p_resolved_by,
        resolution_notes = p_notes
    WHERE id = p_conflict_id
    RETURNING memory_a_id, memory_b_id
  ),
  touched AS (
    SELECT memory_a_id AS mid FROM closed
    UNION
    SELECT memory_b_id FROM closed
  )
  UPDATE memories m SET conflict_flagged = false
  WHERE m.id IN (SELECT mid FROM touched WHERE mid IS NOT NULL)
    AND COALESCE(m.conflict_flagged, false)
    -- c.id <> p_conflict_id is load-bearing: a data-modifying CTE's writes are NOT
    -- visible to the rest of the same statement, so the row `closed` just resolved
    -- still reads as unresolved here and would veto every clear.
    AND NOT EXISTS (
      SELECT 1 FROM memory_conflicts c
      WHERE c.id <> p_conflict_id
        AND COALESCE(c.resolved, false) = false
        AND (c.memory_a_id = m.id OR c.memory_b_id = m.id));
$function$;

COMMENT ON FUNCTION public.resolve_conflict IS
  'Closes a conflict row AND clears conflict_flagged on either side that has no '
  'other open conflict. Before migration 086 the flag leaked: governance_weight() '
  'kept applying its 0.75 demotion to memories whose conflicts were long resolved.';

-- One-shot backfill of flags already leaked.
UPDATE memories m SET conflict_flagged = false
WHERE COALESCE(m.conflict_flagged, false)
  AND NOT EXISTS (
    SELECT 1 FROM memory_conflicts c
    WHERE COALESCE(c.resolved, false) = false
      AND (c.memory_a_id = m.id OR c.memory_b_id = m.id));

-- ---------------------------------------------------------------------------
-- 6. Index the name-only trigram probe the new lane leans on.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_memories_name_trgm
  ON public.memories USING gin (name extensions.gin_trgm_ops);

COMMIT;
