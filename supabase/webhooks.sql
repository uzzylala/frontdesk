-- Frontdesk Database Webhooks — the production trigger for routing.
--
-- Run this in the Supabase SQL editor AFTER deploying web/. Replace
-- https://YOUR_DEPLOYED_URL with the deployment's origin (no trailing slash)
-- in the two `url` lines below. It cannot run against a local-only setup:
-- Supabase's servers can't call localhost. (Locally the client triggers the
-- same endpoints itself — see VITE_ROUTING_TRIGGER in web/.env.development.)
--
-- Why not `supabase_functions.http_request`, the helper behind the dashboard's
-- "Database Webhooks" page? It only exists once someone clicks "Enable
-- webhooks" there. These triggers call pg_net directly, so the file is
-- self-contained and re-runnable. The request body has the same shape the
-- dashboard webhooks send ({type, table, record, ...}), and web/api/*
-- accepts that shape.
--
-- pg_net is asynchronous: the HTTP call is queued and fired after the
-- inserting transaction commits, so a slow or failing endpoint can never
-- block or roll back a customer's message. If a call is lost, the
-- conversation just stays in the queue, where any agent can pick it up or
-- where the next agent going online pulls it (see web/server/routing.ts).

create extension if not exists pg_net;

-- Fires once per newly created conversation.
create or replace function notify_conversation_created()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
begin
  perform net.http_post(
    url := 'https://YOUR_DEPLOYED_URL/api/route-conversation',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'type', 'INSERT',
      'schema', 'public',
      'table', 'conversations',
      'record', to_jsonb(new)
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists on_conversation_created on conversations;
create trigger on_conversation_created
  after insert on conversations
  for each row
  execute function notify_conversation_created();

-- Fires when an agent's status changes to 'online' (and only then — the WHEN
-- clause skips busy/away transitions and unrelated column updates, which
-- includes the routing code's own last_assigned_at writes).
create or replace function notify_agent_online()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
begin
  perform net.http_post(
    url := 'https://YOUR_DEPLOYED_URL/api/agent-online',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'type', 'UPDATE',
      'schema', 'public',
      'table', 'agents',
      'record', to_jsonb(new),
      'old_record', to_jsonb(old)
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists on_agent_online on agents;
create trigger on_agent_online
  after update of status on agents
  for each row
  when (new.status = 'online' and old.status is distinct from 'online')
  execute function notify_agent_online();

-- Disconnect reaping (POST /api/reap-disconnected) needs no webhook: every
-- connected console triggers it (on a Presence leave, and on a 10s timer), and
-- it's idempotent. If you'd rather not depend on a console being open, a
-- pg_cron job calling that endpoint via net.http_post every ~15s is a drop-in
-- backstop — the endpoint decides purely from the heartbeat table.
--
-- To inspect delivery afterwards (status codes, errors):
--   select id, status_code, error_msg, created from net._http_response order by created desc limit 10;
