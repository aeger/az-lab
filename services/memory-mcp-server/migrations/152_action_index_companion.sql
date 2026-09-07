-- ---------------------------------------------------------------------------
-- 152: atomic-fact companion memories for the daily research series
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS
--   Every daily research row ("AI Memory Research - <date>", "Daily
--   Self-Improvement Research - <date>") now gets a companion memory:
--
--       type        reference
--       name        'Action Index - <date>'
--       expires_at  now() + 7 days   (TTL — the index is disposable, the
--                                     research row it points at is not)
--       extracted_facts.atomic_facts  jsonb array of one-claim-per-entry strings
--
--   No schema migration: `expires_at` (mig 118) and `extracted_facts` (mig 099)
--   are already there. This is functions + one AFTER trigger.
--
-- WHY
--   The daily research row is a long episodic narrative — one 8-20KB blob whose
--   embedding averages a dozen unrelated claims into a single point. Recall
--   over it is coarse: the whole day matches, or nothing does. TMEM
--   (arXiv:2606.04536) measures the explicit/parametric split directly and finds
--   an explicit atomic-fact store plus the parametric (embedded) narrative beats
--   either alone; the atomic layer is what makes a single claim addressable.
--   That is the episodic -> semantic step this repo has been missing: the
--   narrative stays episodic and durable, the distilled claims become
--   individually recallable semantic units, and they expire on their own so a
--   stale index never outlives its usefulness.
--
-- FIVE PARTS
--   1. extract_atomic_facts()  — deterministic bullet distillation, no LLM.
--   2. extract_facts_from_content() PATCHED — it used to CLOBBER
--      extracted_facts with its heuristic entity object on every write, which
--      would have eaten atomic_facts on the next touch of the row. It now
--      MERGES: it owns its six keys, callers keep theirs.
--   3. record_action_index()   — the RPC. Agent-supplied facts win over
--      heuristic ones and are never silently downgraded (see the hash check).
--   4. AFTER trigger on memories — so coverage does not depend on any agent
--      remembering to call the RPC. Exception-safe: a companion failure must
--      never roll back the research write it is derived from.
--   5. memory_is_log_series() — register the series so the companions are
--      point-in-time (not standing claims that "contradict" each other daily)
--      and are excluded from the staleness backlog. Mirrored in
--      claude/scripts/sync-memory.py COLLAPSE_RULES.
--
-- Idempotent. CREATE OR REPLACE + DROP TRIGGER IF EXISTS. Backfill at the end
-- only touches the last 7 days (older companions would be born expired).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- PART 1 — deterministic atomic-fact extraction
-- ---------------------------------------------------------------------------
-- Bullets in these documents are already close to atomic: the synthesis step
-- writes one claim per bullet. This lifts them out, strips markdown, drops
-- fragments and section scaffolding, dedupes case-insensitively, keeps document
-- order. It is deliberately NOT an LLM: the trigger path must be cheap and
-- deterministic. An agent that can do better passes p_facts to
-- record_action_index() and its facts win.
CREATE OR REPLACE FUNCTION public.extract_atomic_facts(
  p_content text,
  p_max     int DEFAULT 12
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH src AS (
    SELECT ord, btrim(l) AS raw
    FROM regexp_split_to_table(coalesce(p_content, ''), E'\n') WITH ORDINALITY AS t(l, ord)
  ),
  bullets AS (
    SELECT ord, btrim(regexp_replace(raw, '^([-*+]|[0-9]+\.)[[:space:]]+', '')) AS body
    FROM src
    WHERE raw ~ '^([-*+]|[0-9]+\.)[[:space:]]+[^[:space:]]'
  ),
  cleaned AS (
    SELECT ord,
           btrim(regexp_replace(
             regexp_replace(
               regexp_replace(body, '\*\*|__|`', '', 'g'),   -- bold/italic/code marks
               '\[([^\]]+)\]\([^)]*\)', '\1', 'g'),          -- [text](url) -> text
             '[[:space:]]+', ' ', 'g')) AS fact
    FROM bullets
  ),
  kept AS (
    SELECT ord, fact
    FROM cleaned
    WHERE length(fact) BETWEEN 30 AND 400        -- drop fragments and whole paragraphs
      AND fact ~ '[A-Za-z]'
      AND fact !~* '^(source|sources|ref|refs|reference|references|see also|link|links|tbd|n/?a)\b'
  ),
  deduped AS (
    SELECT DISTINCT ON (lower(fact)) ord, fact
    FROM kept
    ORDER BY lower(fact), ord
  )
  SELECT coalesce(jsonb_agg(to_jsonb(fact) ORDER BY ord), '[]'::jsonb)
  FROM (SELECT ord, fact FROM deduped ORDER BY ord LIMIT greatest(coalesce(p_max, 12), 1)) s;
$fn$;

COMMENT ON FUNCTION public.extract_atomic_facts(text, int) IS
  'Migration 152. Deterministic bullet -> atomic-fact distillation for Action Index companions. No LLM; an agent with better facts passes them to record_action_index().';

-- ---------------------------------------------------------------------------
-- PART 2 — stop the entity trigger from eating caller-supplied fact keys
-- ---------------------------------------------------------------------------
-- Unchanged behaviour for every existing caller: nothing else writes
-- extracted_facts by hand, so for those rows the merge is a no-op over an
-- empty object. What changes is that a key this trigger does not own now
-- survives a later UPDATE of name/description/content.
CREATE OR REPLACE FUNCTION public.extract_facts_from_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_text       text;
  v_entities   text[];
  v_hashtags   text[];
  v_urls       text[];
  v_ips        text[];
  v_hostnames  text[];
  v_carried    jsonb;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.content     IS NOT DISTINCT FROM OLD.content
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.name        IS NOT DISTINCT FROM OLD.name THEN
    RETURN NEW;
  END IF;

  v_text := COALESCE(NEW.name, '') || E'\n' ||
            COALESCE(NEW.description, '') || E'\n' ||
            COALESCE(NEW.content, '');

  SELECT ARRAY(SELECT DISTINCT lower(m[1])
               FROM regexp_matches(v_text, '\m([a-z][a-z0-9]*-[a-z0-9-]+)\M', 'g') AS t(m))
    INTO v_hostnames;
  SELECT ARRAY(SELECT DISTINCT lower(m[1])
               FROM regexp_matches(v_text, '#([A-Za-z][A-Za-z0-9_-]+)', 'g') AS t(m))
    INTO v_hashtags;
  SELECT ARRAY(SELECT DISTINCT m[1]
               FROM regexp_matches(v_text, '(https?://[^\s)>\]]+)', 'g') AS t(m))
    INTO v_urls;
  SELECT ARRAY(SELECT DISTINCT m[1]
               FROM regexp_matches(v_text, '\m((?:\d{1,3}\.){3}\d{1,3})\M', 'g') AS t(m))
    INTO v_ips;

  v_entities := COALESCE(v_hostnames, '{}') || COALESCE(v_hashtags, '{}') || COALESCE(v_ips, '{}');

  -- Keys this trigger does NOT own (migration 152: atomic_facts and friends).
  v_carried := COALESCE(NEW.extracted_facts, '{}'::jsonb)
               - 'entities' - 'hostnames' - 'hashtags' - 'urls' - 'ips' - 'method';

  NEW.extracted_facts := jsonb_build_object(
    'entities',  to_jsonb(v_entities),
    'hostnames', to_jsonb(v_hostnames),
    'hashtags',  to_jsonb(v_hashtags),
    'urls',      to_jsonb(v_urls),
    'ips',       to_jsonb(v_ips),
    'method',    'heuristic_v1'
  ) || v_carried;
  NEW.facts_extracted_at := now();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- PART 3 — the companion writer
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
  v_date     date := coalesce(p_research_date, (now() AT TIME ZONE 'UTC')::date);
  v_ttl      int  := greatest(coalesce(p_ttl_days, 7), 1);
  v_src      public.memories%ROWTYPE;
  v_existing public.memories%ROWTYPE;
  v_facts    jsonb;
  v_method   text;
  v_hash     text;
  v_name     text;
  v_content  text;
  v_desc     text;
  v_expires  timestamptz;
  v_id       uuid;
  v_inserted boolean;
BEGIN
  -- 1. Resolve the research row this index is derived from.
  IF p_source_memory IS NOT NULL THEN
    SELECT * INTO v_src
    FROM public.memories
    WHERE name = p_source_memory AND is_active
    LIMIT 1;
  ELSE
    -- research_producers (migration 126) is the registry of daily producers;
    -- keying off it means a third series registered later is covered for free.
    SELECT m.* INTO v_src
    FROM public.memories m
    JOIN public.research_producers p
      ON p.active
     AND m.name = replace(p.name_template, '{date}', to_char(v_date, 'YYYY-MM-DD'))
    WHERE m.is_active
    ORDER BY m.updated_at DESC
    LIMIT 1;
  END IF;

  IF v_src.id IS NULL THEN
    RETURN jsonb_build_object(
      'action', 'skipped', 'reason', 'no_source_memory',
      'research_date', to_char(v_date, 'YYYY-MM-DD'));
  END IF;

  v_hash := md5(coalesce(v_src.content, ''));

  -- 2. Facts: caller-supplied win. Accept ["fact", ...] or [{"fact": "..."}].
  IF p_facts IS NOT NULL AND jsonb_typeof(p_facts) = 'array' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY ord), '[]'::jsonb) INTO v_facts
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
    v_method := 'agent_supplied';
  END IF;

  IF v_facts IS NULL OR jsonb_array_length(v_facts) = 0 THEN
    v_facts  := public.extract_atomic_facts(v_src.content, 12);
    v_method := 'heuristic_bullets_v1';
  END IF;

  IF jsonb_array_length(v_facts) = 0 THEN
    RETURN jsonb_build_object(
      'action', 'skipped', 'reason', 'no_facts_extracted',
      'research_date', to_char(v_date, 'YYYY-MM-DD'),
      'source_memory', v_src.name);
  END IF;

  v_name := 'Action Index - ' || to_char(v_date, 'YYYY-MM-DD');

  SELECT * INTO v_existing FROM public.memories WHERE name = v_name AND is_active;

  -- 3. A heuristic pass must never downgrade agent-supplied facts. It may
  --    refresh them if the source narrative actually changed under them.
  IF v_existing.id IS NOT NULL
     AND v_method = 'heuristic_bullets_v1'
     AND v_existing.extracted_facts->>'fact_method' = 'agent_supplied'
     AND v_existing.extracted_facts->>'source_content_hash' = v_hash THEN
    RETURN jsonb_build_object(
      'id',            v_existing.id,
      'name',          v_name,
      'action',        'preserved',
      'fact_method',   'agent_supplied',
      'fact_count',    jsonb_array_length(coalesce(v_existing.extracted_facts->'atomic_facts', '[]'::jsonb)),
      'expires_at',    v_existing.expires_at,
      'source_memory', v_src.name);
  END IF;

  v_expires := now() + make_interval(days => v_ttl);

  SELECT '# Action Index — ' || to_char(v_date, 'YYYY-MM-DD') || E'\n\n'
      || 'Atomic facts distilled from [[' || v_src.name || ']] (' || v_method
      || ', TTL ' || v_ttl || 'd — the narrative is the durable record, this index is not).'
      || E'\n\n'
      || string_agg('- ' || (f #>> '{}'), E'\n' ORDER BY ord)
    INTO v_content
  FROM jsonb_array_elements(v_facts) WITH ORDINALITY AS t(f, ord);

  v_desc := 'Action index — ' || jsonb_array_length(v_facts) || ' atomic facts distilled from '
         || v_src.name || '; expires ' || to_char(v_expires, 'YYYY-MM-DD') || '.';

  -- Provenance is INHERITED from the research row, never asserted. A distillation
  -- cannot be more trustworthy than what it distils (migration 124 caps the tier
  -- from source/writer_agent anyway; passing them through keeps it honest).
  INSERT INTO public.memories AS m (
    type, name, description, content, tags,
    source, writer_agent, memory_class, expires_at, is_point_in_time,
    extracted_facts, confidence
  )
  VALUES (
    'reference', v_name, v_desc, v_content,
    ARRAY['action-index','atomic-facts','daily-research','research'],
    coalesce(v_src.source, 'claude-code'), v_src.writer_agent, 'semantic', v_expires, true,
    jsonb_build_object(
      'atomic_facts',        v_facts,
      'fact_count',          jsonb_array_length(v_facts),
      'fact_method',         v_method,
      'source_memory',       v_src.name,
      'source_memory_id',    v_src.id,
      'source_content_hash', v_hash,
      'research_date',       to_char(v_date, 'YYYY-MM-DD'),
      'ttl_days',            v_ttl),
    coalesce(v_src.confidence, 0.8)
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
        embedding       = NULL          -- re-embed: the bullets changed
  RETURNING m.id, (xmax::text = '0') INTO v_id, v_inserted;

  -- 4. Edge back to the narrative so recall on a fact can reach the full day.
  INSERT INTO public.memory_links (source_id, target_id, relationship, link_type, strength, metadata)
  VALUES (v_id, v_src.id, 'refines', 'semantic', 0.9,
          jsonb_build_object('kind', 'action_index', 'research_date', to_char(v_date, 'YYYY-MM-DD')))
  ON CONFLICT (source_id, target_id, relationship) DO NOTHING;

  RETURN jsonb_build_object(
    'id',            v_id,
    'name',          v_name,
    'action',        CASE WHEN v_inserted THEN 'created' ELSE 'updated' END,
    'fact_method',   v_method,
    'fact_count',    jsonb_array_length(v_facts),
    'expires_at',    v_expires,
    'ttl_days',      v_ttl,
    'research_date', to_char(v_date, 'YYYY-MM-DD'),
    'source_memory', v_src.name);
END;
$fn$;

COMMENT ON FUNCTION public.record_action_index(date, jsonb, text, int) IS
  'Migration 152. Upserts the type=reference "Action Index - <date>" companion (TTL 7d) for a daily research row, carrying atomic facts in extracted_facts.atomic_facts. Fires automatically via memories_action_index_companion; call it directly to supply better (LLM-extracted) facts.';

-- ---------------------------------------------------------------------------
-- PART 4 — fire it automatically after every daily research write
-- ---------------------------------------------------------------------------
-- Coverage that depends on a prompt remembering a step is coverage that stops
-- the first time a prompt is edited. The two live writers do not share a code
-- path (the cloud routine INSERTs directly; record_daily_research() upserts),
-- so the table is the only place both are visible.
CREATE OR REPLACE FUNCTION public.action_index_companion_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_datetext text;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NULL;
  END IF;

  v_datetext := substring(NEW.name from '\d{4}-\d{2}-\d{2}');
  IF v_datetext IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.research_producers p
    WHERE p.active
      AND NEW.name = replace(p.name_template, '{date}', v_datetext)
  ) THEN
    RETURN NULL;
  END IF;

  -- The companion is derived data. If distilling it fails — or the name carries
  -- an uncastable date — the day's research still has to land; an AFTER trigger
  -- raising here would roll the INSERT back.
  BEGIN
    PERFORM public.record_action_index(v_datetext::date, NULL, NEW.name, 7);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'action_index_companion: % (%) writing companion for "%"',
      SQLERRM, SQLSTATE, NEW.name;
  END;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS memories_action_index_companion ON public.memories;
CREATE TRIGGER memories_action_index_companion
AFTER INSERT OR UPDATE OF content ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.action_index_companion_trigger();

-- ---------------------------------------------------------------------------
-- PART 5 — register the series (point-in-time + staleness exclusion)
-- ---------------------------------------------------------------------------
-- Without this the companions read as ~7 standing claims that disagree, which
-- is exactly the shape last_writer_wins retires (see migration 135 part 2).
CREATE OR REPLACE FUNCTION public.memory_is_log_series(p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_name IS NULL THEN false ELSE (
    WITH raw AS (
      SELECT p_name AS n
      UNION ALL
      SELECT regexp_replace(p_name, '^(semantic|episodic|ref|weekly-ref|summary):\s*', '', 'i')
    ),
    s AS (
      SELECT trim(both '_' from
               regexp_replace(
                 regexp_replace(lower(n), '[''—–\-]', '', 'g'),
                 '[^a-z0-9]+', '_', 'g')) AS slug
      FROM raw
    )
    SELECT bool_or(
           slug ~ '^ai_memory_research_\d'
        OR slug ~ '^daily_selfimprovement_research_\d'
        OR slug ~ '^ai_research_20\d'
        OR slug ~ '^action_index_\d'
        OR slug ~ '^(research|daily).*(triage|review|closeout|synthesis)'
        OR slug ~ '^dailyaimemoryresearchtriage'
        OR slug ~ '^state_of_lab_20\d'
        OR slug ~ '^dreaming(_summary)?_'
        OR slug ~ '^weeklyref_'
        OR slug ~ 'tech_breakthrough'
        OR slug ~ '^constitutionaudit'
        OR slug ~ '^weeklyrlsaudit'
    )
    FROM s
  ) END;
$function$;

-- ---------------------------------------------------------------------------
-- PART 6 — record_daily_research() reports the companion it produced
-- ---------------------------------------------------------------------------
-- Same signature, same behaviour; the AFTER trigger has already run by the time
-- the RETURN is built, so this is a read of what just happened, not a second write.
CREATE OR REPLACE FUNCTION public.record_daily_research(p_research_date date, p_content text, p_description text DEFAULT NULL::text, p_tags text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name     text;
  v_desc     text;
  v_tags     text[];
  v_id       uuid;
  v_tier     text;
  v_inserted boolean;
  v_idx_name text;
  v_idx      jsonb;
BEGIN
  IF p_research_date IS NULL THEN
    RAISE EXCEPTION 'record_daily_research: p_research_date is required';
  END IF;

  IF p_research_date > ((now() AT TIME ZONE 'UTC')::date + 1) THEN
    RAISE EXCEPTION 'record_daily_research: p_research_date % is in the future', p_research_date;
  END IF;

  IF p_content IS NULL OR btrim(p_content) = '' THEN
    RAISE EXCEPTION 'record_daily_research: p_content is required and must not be blank';
  END IF;

  v_name := 'Daily Self-Improvement Research - ' || to_char(p_research_date, 'YYYY-MM-DD');

  v_desc := coalesce(
    nullif(btrim(coalesce(p_description, '')), ''),
    'Daily AI memory / self-improvement research findings for '
      || to_char(p_research_date, 'YYYY-MM-DD') || '.'
  );

  v_tags := ARRAY(
    SELECT DISTINCT t
    FROM unnest(
      ARRAY['research','ai-memory','daily-research','agentic']
      || coalesce(p_tags, ARRAY[]::text[])
    ) AS t
    WHERE btrim(coalesce(t, '')) <> ''
  );

  INSERT INTO public.memories AS m (
    type, name, description, content, tags,
    source, writer_agent, memory_class, trust_tier
  )
  VALUES (
    'project', v_name, v_desc, p_content, v_tags,
    'claude-ai', 'iris', 'semantic',
    'unknown'
  )
  ON CONFLICT (name) WHERE is_active DO UPDATE
    SET content      = EXCLUDED.content,
        description  = EXCLUDED.description,
        tags         = EXCLUDED.tags,
        type         = EXCLUDED.type,
        source       = EXCLUDED.source,
        writer_agent = EXCLUDED.writer_agent,
        trust_tier   = 'unknown',
        embedding    = NULL
  RETURNING m.id, m.trust_tier, (xmax::text = '0')
  INTO v_id, v_tier, v_inserted;

  -- Migration 152: the companion was written by memories_action_index_companion
  -- during the statement above. Report it so the caller knows whether the
  -- heuristic distillation found anything worth indexing.
  v_idx_name := 'Action Index - ' || to_char(p_research_date, 'YYYY-MM-DD');
  SELECT jsonb_build_object(
           'name',        a.name,
           'fact_count',  a.extracted_facts->'fact_count',
           'fact_method', a.extracted_facts->>'fact_method',
           'expires_at',  a.expires_at)
    INTO v_idx
  FROM public.memories a
  WHERE a.name = v_idx_name AND a.is_active;

  RETURN jsonb_build_object(
    'id',            v_id,
    'name',          v_name,
    'research_date', to_char(p_research_date, 'YYYY-MM-DD'),
    'trust_tier',    v_tier,
    'writer_agent',  'iris',
    'source',        'claude-ai',
    'action',        CASE WHEN v_inserted THEN 'created' ELSE 'updated' END,
    'action_index',  coalesce(v_idx, jsonb_build_object('name', v_idx_name, 'status', 'not_written'))
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- PART 7 — grants (migration 149/150 posture: never anon, never PUBLIC)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_action_index(date, jsonb, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_action_index(date, jsonb, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_action_index(date, jsonb, text, int) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.action_index_companion_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.action_index_companion_trigger() FROM anon;

REVOKE ALL ON FUNCTION public.extract_atomic_facts(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.extract_atomic_facts(text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.extract_atomic_facts(text, int) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.extract_facts_from_content() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.extract_facts_from_content() FROM anon;

-- ---------------------------------------------------------------------------
-- PART 8 — backfill the last 7 days only
-- ---------------------------------------------------------------------------
-- A companion for an older day would be created already past its TTL, which is
-- noise, not history. The narrative rows remain the durable record either way.
DO $backfill$
DECLARE
  r   record;
  res jsonb;
  n   int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT substring(m.name from '\d{4}-\d{2}-\d{2}')::date AS d, m.name
    FROM public.memories m
    JOIN public.research_producers p
      ON p.active
     AND m.name = replace(p.name_template, '{date}', substring(m.name from '\d{4}-\d{2}-\d{2}'))
    WHERE m.is_active
      AND substring(m.name from '\d{4}-\d{2}-\d{2}')::date
          >= ((now() AT TIME ZONE 'UTC')::date - 6)
    ORDER BY 1 DESC
  LOOP
    res := public.record_action_index(r.d, NULL, r.name, 7);
    RAISE NOTICE 'backfill %: %', r.name, res;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'migration 152 backfill: % research rows processed', n;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- VERIFY — fail loudly rather than land half-installed
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_facts jsonb;
  v_ok    boolean;
BEGIN
  -- extraction actually extracts
  v_facts := public.extract_atomic_facts(
    E'# Head\n\n- A claim long enough to survive the 30-character floor filter.\n- short\n- **Another** claim, also long enough to survive the length floor here.\n');
  IF jsonb_array_length(v_facts) <> 2 THEN
    RAISE EXCEPTION 'migration 152: extract_atomic_facts returned % facts, expected 2 (%)',
      jsonb_array_length(v_facts), v_facts;
  END IF;
  IF v_facts->>1 LIKE '%**%' THEN
    RAISE EXCEPTION 'migration 152: markdown not stripped from atomic facts (%)', v_facts;
  END IF;

  -- the series is registered
  IF NOT public.memory_is_log_series('Action Index - 2026-09-07') THEN
    RAISE EXCEPTION 'migration 152: Action Index series not registered in memory_is_log_series';
  END IF;

  -- the trigger is attached
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.memories'::regclass
      AND tgname = 'memories_action_index_companion'
      AND NOT tgisinternal) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 152: memories_action_index_companion trigger missing';
  END IF;

  RAISE NOTICE 'migration 152 verify: OK';
END
$verify$;
