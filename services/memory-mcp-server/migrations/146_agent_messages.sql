-- 146_agent_messages.sql
-- Realtime agent message pathway ("Relay") — the message log + fan-out source
-- for Wren/Atlas/Iris/Jeff live messaging. Plan: ~/.claude/plans (2026-08-29,
-- Jeff-approved). task_queue remains the durable work store; this table carries
-- interactive traffic. Deliberately NO triggers and NO gate interaction.
--
-- Fan-out is Supabase Realtime (postgres_changes INSERT). task_queue and
-- memories are already in the supabase_realtime publication; this adds
-- agent_messages alongside them.

CREATE TABLE public.agent_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent   text NOT NULL,                  -- 'wren'|'atlas'|'iris'|'jeff'|'system'
  to_agent     text,                           -- NULL = broadcast
  kind         text NOT NULL DEFAULT 'chat'
               CHECK (kind IN ('chat','task','status','system')),
  body         text NOT NULL,
  task_id      uuid REFERENCES public.task_queue(id),
  thread_id    uuid,                           -- optional reply-chain grouping
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  acked_at     timestamptz,
  meta         jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX agent_messages_to_agent_created_idx
  ON public.agent_messages (to_agent, created_at DESC);
CREATE INDEX agent_messages_created_idx
  ON public.agent_messages (created_at DESC);

ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_all ON public.agent_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_messages;
