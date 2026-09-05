-- 146a_agent_messages_realtime_read.sql
-- Hotfix for 146. Supabase Realtime authorizes postgres_changes as the ROLE of
-- the connecting apikey; the listeners connect with the publishable (anon) key,
-- as memory-mcp's memory-sync listener does. With only a service_role policy on
-- agent_messages, Realtime silently delivered nothing — the relay saw live
-- task_queue events but never an agent_messages event (observed 2026-08-29).
--
-- task_queue and memories, both already in the supabase_realtime publication,
-- carry exactly these anon/authenticated SELECT policies. This matches that
-- convention; writes remain service_role-only.

CREATE POLICY anon_read_agent_messages ON public.agent_messages
  FOR SELECT TO anon USING (true);
CREATE POLICY authenticated_read_agent_messages ON public.agent_messages
  FOR SELECT TO authenticated USING (true);
