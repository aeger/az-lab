-- ---------------------------------------------------------------------------
-- 152a: the Action Index is per-DAY, but a day can have more than one producer
-- ---------------------------------------------------------------------------
-- WHAT 152 GOT WRONG (caught in its own backfill, before any daily run)
--   research_producers holds TWO active daily series. On 2026-09-01..09-06 both
--   'AI Memory Research - <date>' and 'Daily Self-Improvement Research - <date>'
--   exist. 152's record_action_index() distilled ONE of them and wrote it to
--   'Action Index - <date>'; the AFTER trigger then fired again for the second
--   row and overwrote the file wholesale. Whichever series landed last won, and
--   the other day's research was silently absent from the index that claims to
--   index the day. The backfill made this visible: two 'refines' edges out of
--   each companion, but only one series' facts in atomic_facts.
--
--   A per-day artifact keyed on one source is a per-source artifact wearing a
--   per-day name.
--
-- WHAT THIS CHANGES
--   record_action_index() now rebuilds the companion from EVERY active producer
--   row for the date, one section per source, deduped across sections. Rebuild
--   (not append) keeps it idempotent: firing it three times on the same day
--   yields the same document.
--
--   Agent-supplied facts are now retained PER SOURCE in
--   extracted_facts.agent_facts = {"<source name>": {hash, facts}}. On rebuild a
--   source's agent facts are reused while that source's content hash is
--   unchanged, and fall back to heuristic distillation once it changes. Before
--   this, a heuristic rebuild triggered by series B erased the good facts an
--   agent had supplied for series A.
--
-- Idempotent. CREATE OR REPLACE + a rebuild of the last 7 days.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_action_index(
  p_research_date date    DEFAULT NULL,
  p_facts         jsonb   DEFAULT NULL,
  p_source_memory text    DEFAULT NULL,
  p_ttl_days      int     DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_date       date := coalesce(p_research_date, (now() AT TIME ZONE 'UTC')::date);
  v_datestr    text := to_char(coalesce(p_research_date, (now() AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD');
  v_ttl        int  := greatest(coalesce(p_ttl_days, 7), 1);
  v_name       text;
  v_row        public.memories%ROWTYPE;
  v_primary    public.memories%ROWTYPE;
  v_existing   public.memories%ROWTYPE;
  v_prior      jsonb := '{}'::jsonb;   -- prior agent_facts map, keyed by source name
  v_agent      jsonb := '{}'::jsonb;   -- rebuilt agent_facts map
  v_sources    jsonb := '[]'::jsonb;
  v_sections   text[] := ARRAY[]::text[];
  v_all        text[] := ARRAY[]::text[];
  v_seen       text[] := ARRAY[]::text[];
  v_supplied   jsonb;
  v_facts      jsonb;
  v_fresh      text[];
  v_hash       text;
  v_method     text;
  v_methods    text[] := ARRAY[]::text[];
  v_content    text;
  v_desc       text;
  v_expires    timestamptz;
  v_id         uuid;
  v_inserted   boolean;
  v_n          int;
BEGIN
  v_name := 'Action Index - ' || v_datestr;

  -- Normalise caller-supplied facts once: ["fact", ...] or [{"fact": "..."}].
  IF p_facts IS NOT NULL AND jsonb_typeof(p_facts) = 'array' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY ord), '[]'::jsonb) INTO v_supplied
    FROM (
      SELECT ord,
             btrim(CASE
               WHEN jsonb_typeof(e) = 'string' THEN e #>> '{}'
               WHEN jsonb_typeof(e) = 'object' THEN coalesce(e->>'fact', e->>'text', e->>'claim')
               ELSE NULL
             END) AS f
      FROM jsonb_array_elements(p_facts) WITH ORDINALITY AS t(e, ord)
    ) s
    WHERE coalesce(length(f), 0) > 0;
    IF jsonb_array_length(coalesce(v_supplied, '[]'::jsonb)) = 0 THEN
      v_supplied := NULL;
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.memories WHERE name = v_name AND is_active;
  IF v_existing.id IS NOT NULL THEN
    v_prior := coalesce(v_existing.extracted_facts->'agent_facts', '{}'::jsonb);
  END IF;

  -- Every active producer row for the date, plus an explicitly named source that
  -- is not (yet) a registered producer.
  FOR v_row IN
    SELECT m.*
    FROM public.memories m
    WHERE m.is_active
      AND (
        EXISTS (SELECT 1 FROM public.research_producers p
                WHERE p.active
                  AND m.name = replace(p.name_template, '{date}', v_datestr))
        OR (p_source_memory IS NOT NULL AND m.name = p_source_memory)
      )
    ORDER BY m.name
  LOOP
    v_hash := md5(coalesce(v_row.content, ''));

    -- Fact source, in precedence order:
    --   1. facts this call supplied for this row
    --   2. agent facts already stored for this row, if its content has not moved
    --   3. deterministic distillation
    IF v_supplied IS NOT NULL AND v_row.name = p_source_memory THEN
      v_facts  := v_supplied;
      v_method := 'agent_supplied';
    ELSIF v_prior->v_row.name IS NOT NULL
      AND v_prior->v_row.name->>'hash' = v_hash
      AND jsonb_array_length(coalesce(v_prior->v_row.name->'facts', '[]'::jsonb)) > 0 THEN
      v_facts  := v_prior->v_row.name->'facts';
      v_method := 'agent_supplied';
    ELSE
      v_facts  := public.extract_atomic_facts(v_row.content, 12);
      v_method := 'heuristic_bullets_v1';
    END IF;

    IF v_method = 'agent_supplied' THEN
      v_agent := v_agent || jsonb_build_object(
        v_row.name, jsonb_build_object('hash', v_hash, 'facts', v_facts));
    END IF;

    -- Dedupe across sources: the two series overlap on the papers they cite.
    SELECT coalesce(array_agg(f ORDER BY ord), ARRAY[]::text[]) INTO v_fresh
    FROM (
      SELECT ord, (e #>> '{}') AS f
      FROM jsonb_array_elements(v_facts) WITH ORDINALITY AS t(e, ord)
    ) s
    WHERE lower(f) <> ALL (coalesce(v_seen, ARRAY[]::text[]));

    IF array_length(v_fresh, 1) > 0 THEN
      v_seen     := v_seen || ARRAY(SELECT lower(x) FROM unnest(v_fresh) x);
      v_all      := v_all || v_fresh;
      v_sections := v_sections
        || ('## ' || v_row.name || E'\n' || array_to_string(
              ARRAY(SELECT '- ' || x FROM unnest(v_fresh) x), E'\n'));
      v_methods  := v_methods || v_method;
    END IF;

    v_sources := v_sources || jsonb_build_object(
      'name',   v_row.name,
      'id',     v_row.id,
      'hash',   v_hash,
      'method', v_method,
      'count',  coalesce(array_length(v_fresh, 1), 0));

    IF v_primary.id IS NULL
       OR (p_source_memory IS NOT NULL AND v_row.name = p_source_memory) THEN
      v_primary := v_row;
    END IF;
  END LOOP;

  IF v_primary.id IS NULL THEN
    RETURN jsonb_build_object('action','skipped','reason','no_source_memory','research_date',v_datestr);
  END IF;

  v_n := coalesce(array_length(v_all, 1), 0);
  IF v_n = 0 THEN
    RETURN jsonb_build_object('action','skipped','reason','no_facts_extracted',
                              'research_date',v_datestr,'sources',v_sources);
  END IF;

  v_method := CASE
    WHEN 'agent_supplied' = ALL (v_methods)        THEN 'agent_supplied'
    WHEN 'agent_supplied' = ANY (v_methods)        THEN 'mixed'
    ELSE 'heuristic_bullets_v1'
  END;

  v_expires := now() + make_interval(days => v_ttl);

  v_content := '# Action Index — ' || v_datestr || E'\n\n'
    || v_n || ' atomic facts distilled from ' || jsonb_array_length(v_sources)
    || ' research row(s) (' || v_method || ', TTL ' || v_ttl
    || 'd — the narrative rows are the durable record, this index is not).' || E'\n\n'
    || array_to_string(v_sections, E'\n\n');

  v_desc := 'Action index — ' || v_n || ' atomic facts from the ' || v_datestr
         || ' research row(s); expires ' || to_char(v_expires, 'YYYY-MM-DD') || '.';

  INSERT INTO public.memories AS m (
    type, name, description, content, tags,
    source, writer_agent, memory_class, expires_at, is_point_in_time,
    extracted_facts, confidence
  )
  VALUES (
    'reference', v_name, v_desc, v_content,
    ARRAY['action-index','atomic-facts','daily-research','research'],
    coalesce(v_primary.source, 'claude-code'), v_primary.writer_agent, 'semantic',
    v_expires, true,
    jsonb_build_object(
      'atomic_facts',        to_jsonb(v_all),
      'fact_count',          v_n,
      'fact_method',         v_method,
      'sources',             v_sources,
      'agent_facts',         v_agent,
      'source_memory',       v_primary.name,
      'source_memory_id',    v_primary.id,
      'source_content_hash', md5(v_sources::text),
      'research_date',       v_datestr,
      'ttl_days',            v_ttl),
    coalesce(v_primary.confidence, 0.8)
  )
  ON CONFLICT (name) WHERE is_active DO UPDATE
    SET description     = EXCLUDED.description,
        content         = EXCLUDED.content,
        tags            = EXCLUDED.tags,
        type            = EXCLUDED.type,
        memory_class    = EXCLUDED.memory_class,
        expires_at      = EXCLUDED.expires_at,
        extracted_facts = EXCLUDED.extracted_facts,
        source          = EXCLUDED.source,
        embedding       = NULL
  RETURNING m.id, (xmax::text = '0') INTO v_id, v_inserted;

  -- One edge per contributing source, so a fact hit can reach any narrative it
  -- came from.
  INSERT INTO public.memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  SELECT v_id, (s->>'id')::uuid, 'refines', 'semantic', 0.9,
         jsonb_build_object('kind','action_index','research_date',v_datestr)
  FROM jsonb_array_elements(v_sources) s
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;

  RETURN jsonb_build_object(
    'id',            v_id,
    'name',          v_name,
    'action',        CASE WHEN v_inserted THEN 'created' ELSE 'updated' END,
    'fact_method',   v_method,
    'fact_count',    v_n,
    'source_count',  jsonb_array_length(v_sources),
    'sources',       v_sources,
    'expires_at',    v_expires,
    'ttl_days',      v_ttl,
    'research_date', v_datestr,
    'source_memory', v_primary.name);
END;
$fn$;

COMMENT ON FUNCTION public.record_action_index(date, jsonb, text, int) IS
  'Migration 152/152a. Rebuilds the type=reference "Action Index - <date>" companion (TTL 7d) from EVERY active daily-research producer row for that date; atomic facts land in extracted_facts.atomic_facts, agent-supplied facts are retained per source in extracted_facts.agent_facts. Fires automatically via memories_action_index_companion.';

REVOKE ALL ON FUNCTION public.record_action_index(date, jsonb, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_action_index(date, jsonb, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_action_index(date, jsonb, text, int) TO service_role, authenticated;

-- Rebuild the companions 152 wrote single-sourced.
DO $rebuild$
DECLARE d date; res jsonb;
BEGIN
  FOR d IN
    SELECT DISTINCT substring(m.name from '\d{4}-\d{2}-\d{2}')::date
    FROM public.memories m
    JOIN public.research_producers p
      ON p.active
     AND m.name = replace(p.name_template, '{date}', substring(m.name from '\d{4}-\d{2}-\d{2}'))
    WHERE m.is_active
      AND substring(m.name from '\d{4}-\d{2}-\d{2}')::date >= ((now() AT TIME ZONE 'UTC')::date - 6)
    ORDER BY 1 DESC
  LOOP
    res := public.record_action_index(d, NULL, NULL, 7);
    RAISE NOTICE 'rebuild %: %', d, res;
  END LOOP;
END
$rebuild$;

-- VERIFY: every companion for a multi-producer day must cite every producer.
DO $verify$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT a.name,
           jsonb_array_length(a.extracted_facts->'sources') AS cited,
           (SELECT count(*) FROM public.memories m
             JOIN public.research_producers p ON p.active
              AND m.name = replace(p.name_template, '{date}', a.extracted_facts->>'research_date')
            WHERE m.is_active) AS available
    FROM public.memories a
    WHERE a.name LIKE 'Action Index - %' AND a.is_active
  LOOP
    IF r.cited < r.available THEN
      RAISE EXCEPTION 'migration 152a: % cites % of % producer rows', r.name, r.cited, r.available;
    END IF;
  END LOOP;
  RAISE NOTICE 'migration 152a verify: OK';
END
$verify$;
