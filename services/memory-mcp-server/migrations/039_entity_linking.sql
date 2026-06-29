-- Migration 039: Entity linking layer for memories
--
-- Implements REC 2 from 2026-05-17 daily AI memory research: extract named
-- az-lab entities (hosts, IPs, services, agents, models, hardware) at write
-- time and use them as an additional RRF lane at recall. Mirrors Mem0's
-- April 2026 entity-matching pattern; high ROI for the named-entity-heavy
-- az-lab corpus where queries like "find anything about MikroTik CRS309"
-- benefit from exact entity matching above lexical/embedding noise.
--
-- Backwards compatible: existing hybrid_recall overloads keep working. New
-- 11-arg overload accepts p_query_entities; when NULL it auto-extracts from
-- p_query_text so callers don't need to change.

-- ---------------------------------------------------------------------------
-- 1) entity_dictionary — curated lookup of known az-lab entities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_dictionary (
  id           SERIAL PRIMARY KEY,
  entity       TEXT        NOT NULL,
  category     TEXT        NOT NULL CHECK (category IN ('host','ip','service','agent','model','hardware','domain','vlan')),
  canonical    TEXT,       -- optional normalised form (e.g. "svc-podman-01" for "svc-podman", "this host")
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_dictionary_entity_lower_unique
  ON public.entity_dictionary (lower(entity));

ALTER TABLE public.entity_dictionary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.entity_dictionary;
CREATE POLICY "service_role_all" ON public.entity_dictionary
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_read" ON public.entity_dictionary;
CREATE POLICY "authenticated_read" ON public.entity_dictionary
  FOR SELECT TO authenticated USING (true);

-- Seed entities — az-lab named entities that drive most queries
INSERT INTO public.entity_dictionary (entity, category, canonical) VALUES
  -- Hosts
  ('svc-podman-01',  'host', 'svc-podman-01'),
  ('MS-01',          'host', 'ms-01-proxmox'),
  ('nemoclaw-01',    'host', 'nemoclaw-01'),
  ('proxmox',        'host', 'ms-01-proxmox'),
  ('Home Assistant', 'host', 'home-assistant'),
  -- IPs (static + key LAN)
  ('192.168.1.181', 'ip', 'svc-podman-01'),
  ('192.168.1.182', 'ip', 'ms-01-proxmox'),
  ('192.168.1.183', 'ip', 'nemoclaw-01'),
  ('192.168.1.161', 'ip', 'home-assistant'),
  ('192.168.30.10', 'ip', 'game-server'),
  ('192.168.99.2',  'ip', 'adguard'),
  ('192.168.99.248','ip', 'crs309'),
  ('70.167.221.51', 'ip', 'cox-static-1'),
  ('70.167.221.52', 'ip', 'cox-static-2'),
  -- Services
  ('traefik',        'service', 'traefik'),
  ('authelia',       'service', 'authelia'),
  ('cf-ddns',        'service', 'cf-ddns'),
  ('memory-mcp',     'service', 'memory-mcp-server'),
  ('memory-mcp-server','service','memory-mcp-server'),
  ('gmail-mcp',      'service', 'gmail-mcp-server'),
  ('sentinel',       'service', 'sentinel'),
  ('dashboard',      'service', 'dashboard'),
  ('lldap',          'service', 'lldap'),
  ('drydock',        'service', 'drydock'),
  ('webtop',         'service', 'webtop'),
  ('rustdesk',       'service', 'rustdesk'),
  ('changedetect',   'service', 'changedetect'),
  ('grafana',        'service', 'grafana'),
  ('prometheus',     'service', 'prometheus'),
  ('adguard',        'service', 'adguard'),
  ('agent bus',      'service', 'agent-bus'),
  -- Agents
  ('Wren',   'agent', 'wren'),
  ('Iris',   'agent', 'iris'),
  ('Atlas',  'agent', 'atlas'),
  ('Volt',   'agent', 'volt'),
  ('Hermes', 'agent', 'hermes'),
  ('Lumen',  'agent', 'lumen'),
  ('Forge',  'agent', 'forge'),
  -- Models
  ('Opus',     'model', 'claude-opus'),
  ('Sonnet',   'model', 'claude-sonnet'),
  ('Haiku',    'model', 'claude-haiku'),
  ('Nemotron', 'model', 'nemotron'),
  ('Gemini',   'model', 'gemini'),
  ('GPT-5',    'model', 'gpt-5'),
  ('Llama',    'model', 'llama'),
  ('Qwen',     'model', 'qwen'),
  ('DeepSeek', 'model', 'deepseek'),
  -- Hardware
  ('MikroTik',     'hardware', 'mikrotik'),
  ('CRS309',       'hardware', 'crs309'),
  ('RB5009',       'hardware', 'rb5009'),
  ('RTX 5070 Ti',  'hardware', 'rtx-5070-ti'),
  ('RTX 5070',     'hardware', 'rtx-5070'),
  ('Silverstone',  'hardware', 'silverstone'),
  -- Domains
  ('az-lab.dev',  'domain', 'az-lab.dev'),
  ('Cloudflare',  'domain', 'cloudflare'),
  ('Supabase',    'service', 'supabase'),
  ('Cox Business','domain', 'cox'),
  -- VLANs
  ('VLAN10', 'vlan', 'vlan10-main'),
  ('VLAN20', 'vlan', 'vlan20-iot'),
  ('VLAN30', 'vlan', 'vlan30-game'),
  ('VLAN99', 'vlan', 'vlan99-mgmt')
ON CONFLICT (lower(entity)) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) extract_entities(text) — returns canonical entity names found in text
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.extract_entities(p_text TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_canonicals TEXT[];
BEGIN
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- Word-boundary case-insensitive match against curated dictionary.
  -- Postgres \m / \M handle word boundaries at the first/last char of multi-word entities.
  SELECT COALESCE(array_agg(DISTINCT COALESCE(canonical, lower(entity))), ARRAY[]::TEXT[])
    INTO v_canonicals
  FROM public.entity_dictionary d
  WHERE p_text ~* ('\m' || regexp_replace(d.entity, '([.+*?^${}()|\[\]\\])', '\\\1', 'g') || '\M');

  RETURN v_canonicals;
END;
$$;

GRANT EXECUTE ON FUNCTION public.extract_entities(text) TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- 3) memories.entities column + GIN index
-- ---------------------------------------------------------------------------
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS entities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS memories_entities_gin
  ON public.memories USING GIN (entities);

-- ---------------------------------------------------------------------------
-- 4) Trigger — auto-populate entities on INSERT/UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.memories_extract_entities_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.entities := public.extract_entities(
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.description, '') || ' ' ||
    COALESCE(NEW.content, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_extract_entities_biu ON public.memories;
CREATE TRIGGER memories_extract_entities_biu
  BEFORE INSERT OR UPDATE OF name, description, content
  ON public.memories
  FOR EACH ROW
  EXECUTE FUNCTION public.memories_extract_entities_trigger();

-- ---------------------------------------------------------------------------
-- 5) Entity-aware hybrid_recall overload (11 args; backwards compatible)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hybrid_recall(
  p_query_text      text,
  p_query_embedding text    DEFAULT NULL,
  p_match_threshold float   DEFAULT 0.3,
  p_match_count     int     DEFAULT 20,
  p_filter_type     text    DEFAULT NULL,
  p_agent_id        text    DEFAULT NULL,
  p_agent_scope     text    DEFAULT NULL,
  p_min_confidence  float   DEFAULT 0.0,
  p_memory_class    text    DEFAULT NULL,
  p_topic_hint      text    DEFAULT NULL,
  p_query_entities  text[]  DEFAULT NULL
)
RETURNS TABLE(
  id                  uuid,
  type                text,
  name                text,
  description         text,
  content             text,
  tags                text[],
  source              text,
  conflict_flagged    boolean,
  access_count        integer,
  importance_score    float,
  hybrid_score        float,
  confidence          float,
  staleness_candidate boolean,
  memory_class        text,
  matched_entities    text[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_embedding vector(768);
  result_ids  uuid[];
  v_topic     text := NULLIF(TRIM(COALESCE(p_topic_hint, '')), '');
  v_entities  text[];
BEGIN
  IF p_query_embedding IS NOT NULL THEN
    v_embedding := p_query_embedding::vector;
  END IF;

  -- Auto-extract entities from the query text when caller didn't supply them.
  v_entities := COALESCE(p_query_entities, public.extract_entities(p_query_text));
  IF v_entities IS NOT NULL AND array_length(v_entities, 1) IS NULL THEN
    v_entities := NULL;
  END IF;

  -- Single-pass: compute ranked results, capture ids, bump access stats.
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL
      AND m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  -- Entity overlap: rank by count of shared entities between query and memory.
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC
      ) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL
      AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),     0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank),  0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank),  0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank),  0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank),  0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),    0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  ),
  ranked AS (
    SELECT m.id, m.type, m.name, m.description, m.content, m.tags, m.source,
      m.conflict_flagged,
      COALESCE(m.access_count, 0)::integer AS access_count,
      COALESCE(m.importance_score, 0.5)::float AS importance_score,
      (
        0.25 * EXP(-0.1 * GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
          0.0))
      + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
      + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
      + 0.25 * COALESCE(m.importance_score, 0.5)
      + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
      + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
      )::float AS hybrid_score,
      COALESCE(m.confidence, 0.8)::float AS confidence,
      COALESCE(m.staleness_candidate, false) AS staleness_candidate,
      m.memory_class,
      CASE
        WHEN v_entities IS NOT NULL
        THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))
        ELSE ARRAY[]::text[]
      END AS matched_entities
    FROM rrf
    JOIN memories m ON m.id = rrf.mem_id
    WHERE (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    ORDER BY hybrid_score DESC
    LIMIT p_match_count
  )
  SELECT ARRAY_AGG(ranked.id) INTO result_ids FROM ranked;

  IF result_ids IS NOT NULL AND array_length(result_ids, 1) > 0 THEN
    UPDATE memories mem_upd
    SET access_count     = COALESCE(mem_upd.access_count, 0) + 1,
        recall_count     = COALESCE(mem_upd.recall_count, 0) + 1,
        accessed_at      = now(),
        last_accessed_at = now(),
        last_accessed    = now()
    WHERE mem_upd.id = ANY(result_ids);
  END IF;

  -- Re-emit the result set (CTE was consumed by the SELECT INTO above).
  RETURN QUERY
  WITH
  vec_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY (m.embedding::vector) <=> v_embedding ASC) AS vec_rank
    FROM memories m
    WHERE v_embedding IS NOT NULL
      AND m.embedding IS NOT NULL
      AND (1.0 - (m.embedding::vector <=> v_embedding)) >= p_match_threshold
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  bm25_weighted AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', p_query_text)) DESC) AS bm25w_rank
    FROM memories m
    WHERE m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  bm25_plain AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', p_query_text)) DESC) AS bm25p_rank
    FROM memories m
    WHERE m.search_vector IS NOT NULL
      AND m.search_vector @@ plainto_tsquery('english', p_query_text)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  topic_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.search_vec, plainto_tsquery('english', v_topic)) DESC) AS topic_rank
    FROM memories m
    WHERE v_topic IS NOT NULL
      AND m.search_vec IS NOT NULL
      AND m.search_vec @@ plainto_tsquery('english', v_topic)
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  entity_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (
        ORDER BY cardinality(ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))) DESC
      ) AS entity_rank
    FROM memories m
    WHERE v_entities IS NOT NULL
      AND m.entities && v_entities
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
    LIMIT p_match_count * 3
  ),
  trgm_ranked AS (
    SELECT m.id AS mem_id,
      ROW_NUMBER() OVER (ORDER BY similarity(
        m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text
      ) DESC) AS trgm_rank
    FROM memories m
    WHERE similarity(m.name || ' ' || COALESCE(m.description, '') || ' ' || m.content, p_query_text) > 0.01
      AND (p_filter_type IS NULL OR m.type = p_filter_type)
      AND (p_agent_id IS NULL OR m.visibility = 'shared' OR m.agent_id = p_agent_id)
      AND (p_agent_scope IS NULL OR 'shared' = ANY(m.agent_scope) OR p_agent_scope = ANY(m.agent_scope))
      AND (p_min_confidence = 0.0 OR COALESCE(m.confidence, 0.8) >= p_min_confidence)
      AND (p_memory_class IS NULL OR m.memory_class = p_memory_class)
      AND NOT EXISTS (SELECT 1 FROM bm25_weighted)
      AND NOT EXISTS (SELECT 1 FROM bm25_plain)
    LIMIT p_match_count * 3
  ),
  rrf AS (
    SELECT
      COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id, t.mem_id) AS mem_id,
      (  COALESCE(1.0 / (60.0 + v.vec_rank),     0.0)
       + COALESCE(1.2 / (60.0 + bw.bm25w_rank),  0.0)
       + COALESCE(0.8 / (60.0 + bp.bm25p_rank),  0.0)
       + COALESCE(1.5 / (60.0 + tp.topic_rank),  0.0)
       + COALESCE(1.3 / (60.0 + e.entity_rank),  0.0)
       + COALESCE(0.5 / (60.0 + t.trgm_rank),    0.0)
      ) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN bm25_weighted bw ON v.mem_id = bw.mem_id
    FULL OUTER JOIN bm25_plain    bp ON COALESCE(v.mem_id, bw.mem_id) = bp.mem_id
    FULL OUTER JOIN topic_ranked  tp ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id) = tp.mem_id
    FULL OUTER JOIN entity_ranked e  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id) = e.mem_id
    FULL OUTER JOIN trgm_ranked   t  ON COALESCE(v.mem_id, bw.mem_id, bp.mem_id, tp.mem_id, e.mem_id) = t.mem_id
  )
  SELECT
    m.id, m.type, m.name, m.description, m.content, m.tags, m.source, m.conflict_flagged,
    COALESCE(m.access_count, 0)::integer,
    COALESCE(m.importance_score, 0.5)::float,
    (
      0.25 * EXP(-0.1 * GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(m.last_accessed, m.last_accessed_at, m.created_at, now()))) / 86400.0,
        0.0))
    + 0.20 * LEAST(LN(1.0 + COALESCE(m.access_count, 0)::float) / LN(101.0), 1.0)
    + 0.15 * COALESCE(m.amac_novelty_score, 0.5)
    + 0.25 * COALESCE(m.importance_score, 0.5)
    + 0.15 * LEAST(rrf.rrf_score / 0.033, 1.0)
    + 0.10 * LEAST(LN(1.0 + COALESCE(m.recall_count, 0)::float) / LN(51.0), 1.0)
    )::float AS hybrid_score,
    COALESCE(m.confidence, 0.8)::float,
    COALESCE(m.staleness_candidate, false),
    m.memory_class,
    CASE
      WHEN v_entities IS NOT NULL
      THEN ARRAY(SELECT unnest(m.entities) INTERSECT SELECT unnest(v_entities))
      ELSE ARRAY[]::text[]
    END AS matched_entities
  FROM rrf
  JOIN memories m ON m.id = rrf.mem_id
  WHERE m.id = ANY(result_ids)
  ORDER BY hybrid_score DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.hybrid_recall(text,text,float,int,text,text,text,float,text,text,text[]) TO service_role;

-- Sentinel for readiness checks
CREATE OR REPLACE FUNCTION public.apply_entity_linking_if_missing()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memories' AND column_name='entities'
  ) THEN
    RETURN 'entities column not yet present — run migration 039';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='hybrid_recall'
      AND 'p_query_entities' = ANY(p.proargnames)
  ) THEN
    RETURN 'hybrid_recall entity overload missing — run migration 039';
  END IF;
  RETURN 'entity linking present';
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_entity_linking_if_missing() TO service_role;
