-- Frontdesk Database Webhooks — run these AFTER deploying web/ so
-- YOUR_DEPLOYED_URL below is real and publicly reachable. Not runnable
-- against a local-only setup: Supabase's servers can't call localhost.
--
-- These are the authoritative production trigger for routing (see
-- server/routing.ts and the phase 3 write-up for why). Locally, without a
-- deployed URL, the client calls the same api/*.ts endpoints directly
-- instead — see useCustomerConversation.ts and useCurrentAgent.ts.
--
-- Easiest path: create these via Supabase Dashboard → Database → Webhooks
-- (point-and-click, same effect as the SQL below). The SQL form is here so
-- it's reviewable and versioned like everything else in this repo.

create extension if not exists pg_net;

-- Fires once per newly created conversation.
create or replace trigger on_conversation_created
  after insert on conversations
  for each row
  execute function supabase_functions.http_request(
    'https://YOUR_DEPLOYED_URL/api/route-conversation',
    'POST',
    '{"Content-Type":"application/json"}',
    '{}',
    '5000'
  );

-- Fires when an agent's status changes to 'online' (and only then — the
-- WHEN clause skips busy/away transitions and unrelated column updates).
create or replace trigger on_agent_online
  after update of status on agents
  for each row
  when (new.status = 'online' and old.status is distinct from 'online')
  execute function supabase_functions.http_request(
    'https://YOUR_DEPLOYED_URL/api/agent-online',
    'POST',
    '{"Content-Type":"application/json"}',
    '{}',
    '5000'
  );

-- Disconnect reaping (POST /api/reap-disconnected) needs no webhook: every
-- connected console triggers it (on a Presence leave, and on a 10s timer), and
-- it's idempotent. If you'd rather not depend on a console being open, a
-- pg_cron job calling that endpoint via pg_net every ~15s is a drop-in
-- backstop — the endpoint decides purely from the heartbeat table.
