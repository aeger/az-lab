-- Migration 030: Fix hybrid_recall SECURITY DEFINER search_path
--
-- Problem: hybrid_recall is SECURITY DEFINER with search_path=public,pg_temp.
-- The pgvector `vector` type lives in the `extensions` schema, so when PL/pgSQL
-- compiles the function body on first call, the `vector(768)` declaration
-- fails with "type vector does not exist". The MCP server's recall tool wraps
-- the RPC in try/catch and silently falls through to a keyword-only search,
-- masking the failure and defeating the entire 4-lane RRF retrieval path.
--
-- Fix: add `extensions` to the function's SET search_path so the vector type
-- is resolvable. Apply to both signatures (with and without p_memory_class).
-- Idempotent: ALTER FUNCTION ... SET is safe to re-apply.

ALTER FUNCTION public.hybrid_recall(
  p_query_text       text,
  p_query_embedding  text,
  p_match_threshold  double precision,
  p_match_count      integer,
  p_filter_type      text,
  p_agent_id         text,
  p_agent_scope      text,
  p_min_confidence   double precision
) SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.hybrid_recall(
  p_query_text       text,
  p_query_embedding  text,
  p_match_threshold  double precision,
  p_match_count      integer,
  p_filter_type      text,
  p_agent_id         text,
  p_agent_scope      text,
  p_min_confidence   double precision,
  p_memory_class     text
) SET search_path = public, extensions, pg_temp;
