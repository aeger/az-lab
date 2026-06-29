-- Migration 046: GAM-style episodic→semantic consolidation gate
-- Source: 2026-06-15 daily research triage, REC2 (GAM, Sun et al.)
--
-- Adds a stricter similarity gate for episodic memories so consolidate_similar_memories
-- does not silently collapse semantically distinct episodes into one semantic record.
-- Non-episodic pairs continue to merge at p_threshold (default 0.90).
-- Episodic pairs must additionally clear p_episodic_gate (default 0.95).

-- Drop the old 2-arg overload so the new 3-arg signature is unambiguous.
DROP FUNCTION IF EXISTS public.consolidate_similar_memories(double precision, boolean);

CREATE OR REPLACE FUNCTION public.consolidate_similar_memories(
  p_threshold       double precision DEFAULT 0.90,
  p_dry_run         boolean          DEFAULT false,
  p_episodic_gate   double precision DEFAULT 0.95
)
RETURNS TABLE(merged_count integer, deleted_ids uuid[], keeper_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_deleted  uuid[] := '{}';
  v_keepers  uuid[] := '{}';
  v_merged   int    := 0;
  r          record;
BEGIN
  FOR r IN
    SELECT
      a.id       AS id_a,
      b.id       AS id_b,
      a.name     AS name_a,
      b.name     AS name_b,
      a.content  AS content_a,
      b.content  AS content_b,
      a.tags     AS tags_a,
      b.tags     AS tags_b,
      a.memory_class AS class_a,
      b.memory_class AS class_b,
      COALESCE(a.importance_score, 0.5) AS imp_a,
      COALESCE(b.importance_score, 0.5) AS imp_b,
      1.0 - (a.embedding::vector <=> b.embedding::vector) AS cosine_sim
    FROM memories a
    JOIN memories b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND a.type = b.type
      AND (1.0 - (a.embedding::vector <=> b.embedding::vector)) > p_threshold
      AND a.id <> ALL(v_deleted)
      AND b.id <> ALL(v_deleted)
    ORDER BY cosine_sim DESC
    LIMIT 200
  LOOP
    IF r.id_a = ANY(v_deleted) OR r.id_b = ANY(v_deleted) THEN
      CONTINUE;
    END IF;

    -- GAM episodic gate: when either side is episodic, demand stricter similarity.
    IF (r.class_a = 'episodic' OR r.class_b = 'episodic')
       AND r.cosine_sim < p_episodic_gate THEN
      CONTINUE;
    END IF;

    DECLARE
      v_keeper_id  uuid;
      v_delete_id  uuid;
      v_keep_cont  text;
      v_del_cont   text;
      v_merged_tags text[];
    BEGIN
      IF r.imp_a >= r.imp_b THEN
        v_keeper_id := r.id_a; v_keep_cont := r.content_a;
        v_delete_id := r.id_b; v_del_cont  := r.content_b;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_a || COALESCE(r.tags_b, '{}'::text[])));
      ELSE
        v_keeper_id := r.id_b; v_keep_cont := r.content_b;
        v_delete_id := r.id_a; v_del_cont  := r.content_a;
        v_merged_tags := ARRAY(SELECT DISTINCT unnest(r.tags_b || COALESCE(r.tags_a, '{}'::text[])));
      END IF;

      IF NOT p_dry_run THEN
        IF v_keep_cont NOT LIKE '%' || LEFT(v_del_cont, 60) || '%' THEN
          UPDATE memories
          SET content  = v_keep_cont || E'\n\n[Consolidated from: ' || r.name_a || ' / ' || r.name_b || E']\n' || v_del_cont,
              tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        ELSE
          UPDATE memories
          SET tags     = v_merged_tags,
              updated_at = now()
          WHERE id = v_keeper_id;
        END IF;

        INSERT INTO memory_log(memory_id, action, details, created_at)
        VALUES (v_delete_id, 'consolidated',
          jsonb_build_object(
            'keeper_id',     v_keeper_id,
            'cosine_sim',    r.cosine_sim,
            'threshold',     p_threshold,
            'episodic_gate', p_episodic_gate,
            'class_a',       r.class_a,
            'class_b',       r.class_b
          ),
          now()
        ) ON CONFLICT DO NOTHING;

        DELETE FROM memories WHERE id = v_delete_id;
      END IF;

      v_deleted := v_deleted || v_delete_id;
      v_keepers := v_keepers || v_keeper_id;
      v_merged  := v_merged + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_merged, v_deleted, v_keepers;
END;
$function$;

COMMENT ON FUNCTION public.consolidate_similar_memories(double precision, boolean, double precision)
IS 'Consolidate near-duplicate memories. p_threshold = global cosine floor (default 0.90). p_episodic_gate = stricter floor for pairs where either side is memory_class=episodic (default 0.95) — GAM noise-suppression gate added 2026-06-15 (Migration 046).';
