-- Frontdesk schema
-- Run this in the Supabase SQL editor (or via the CLI) on a fresh project.
-- Safe to re-run: every statement is idempotent.

create extension if not exists "pgcrypto";

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open' check (status in ('open', 'closed')),
  customer_name text not null default 'Customer',
  created_at timestamptz not null default now()
);

alter table conversations add column if not exists customer_name text not null default 'Customer';

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  sender_type text not null check (sender_type in ('customer', 'agent')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_created_at_idx
  on messages (conversation_id, created_at);

-- Phase 1 had a single agent with no status. Phase 3 adds status (for
-- routing eligibility) and last_assigned_at (routing tie-break). There is
-- still no real auth — "which agent is this browser" is a client-side
-- picker, not a verified identity (see README).
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'away' check (status in ('online', 'busy', 'away')),
  last_assigned_at timestamptz,
  created_at timestamptz not null default now()
);

alter table agents add column if not exists status text not null default 'away' check (status in ('online', 'busy', 'away'));
alter table agents add column if not exists last_assigned_at timestamptz;

insert into agents (name)
select 'Agent'
where not exists (select 1 from agents);

-- assigned_agent_id null + status='open' is the queue: no separate table,
-- just an absence of assignment.
alter table conversations add column if not exists assigned_agent_id uuid references agents (id);

create index if not exists conversations_assigned_agent_id_idx
  on conversations (assigned_agent_id)
  where status = 'open';

-- Realtime needs each table registered on the supabase_realtime
-- publication. messages was added in phase 1; conversations and agents
-- are needed from phase 3 on (live queue updates, live roster/status sync)
-- — missing this silently breaks postgres_changes for that table with no
-- error, since it's a publication-membership gap, not a permissions one.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table conversations;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'agents'
  ) then
    alter publication supabase_realtime add table agents;
  end if;
end $$;

alter table conversations enable row level security;
alter table messages enable row level security;
alter table agents enable row level security;

-- Phase 1 has no auth yet (widget/console split and agent identity come later
-- phases), so policies are intentionally permissive for anon access to keep
-- the MVP demo-able end to end. These get scoped down once agent auth lands.
drop policy if exists "anon can read conversations" on conversations;
create policy "anon can read conversations" on conversations
  for select to anon using (true);

drop policy if exists "anon can create conversations" on conversations;
create policy "anon can create conversations" on conversations
  for insert to anon with check (true);

drop policy if exists "anon can read messages" on messages;
create policy "anon can read messages" on messages
  for select to anon using (true);

drop policy if exists "anon can insert messages" on messages;
create policy "anon can insert messages" on messages
  for insert to anon with check (true);

drop policy if exists "anon can read agents" on agents;
create policy "anon can read agents" on agents
  for select to anon using (true);

-- Lets an agent toggle their own status from the console. Since there's no
-- real auth, this can't be scoped to "only their own row" server-side yet —
-- any anon caller could update any agent's status. Acceptable for a
-- no-auth demo phase; closes once real auth exists.
drop policy if exists "anon can update agent status" on agents;
create policy "anon can update agent status" on agents
  for update to anon using (true) with check (true);

-- Lets an agent manually pick up a queued (unassigned) conversation. The
-- `using` clause only matches rows that are CURRENTLY unassigned, so this
-- is a Postgres-level atomic compare-and-set: if two agents click "pick up"
-- on the same conversation, the second UPDATE simply matches zero rows
-- instead of racing the first — Postgres serializes the two statements.
drop policy if exists "anon can claim queued conversations" on conversations;
create policy "anon can claim queued conversations" on conversations
  for update to anon
  using (assigned_agent_id is null)
  with check (true);

-- ---------------------------------------------------------------------------
-- Phase 4: presence durability + disconnect reassignment
-- ---------------------------------------------------------------------------

-- Realtime Presence is the live source of truth for "who's connected," but
-- it lives in Realtime's memory and a stateless serverless function can't
-- hold a socket to read it. So each console also heartbeats into this table
-- and functions treat "fresh heartbeat" as "connected." It's a separate
-- table (not a column on agents) so the ~5s write rate doesn't fire a
-- realtime UPDATE event on agents for every subscriber.
create table if not exists agent_heartbeats (
  agent_id uuid primary key references agents (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

-- RLS on with no policies: anon can't read or write the table directly. The
-- only way in is the RPC below, which stamps the DB's own clock (not the
-- client's) so browser clock skew can't fake liveness or staleness.
alter table agent_heartbeats enable row level security;

create or replace function agent_heartbeat(p_agent_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into agent_heartbeats (agent_id, last_seen_at)
  values (p_agent_id, now())
  on conflict (agent_id) do update set last_seen_at = excluded.last_seen_at;
$$;

grant execute on function agent_heartbeat(uuid) to anon;

-- Audit trail for disconnect reassignment. previous_agent_id is kept even
-- after a conversation is re-picked-up, so the UI can show it was transferred.
alter table conversations add column if not exists previous_agent_id uuid references agents (id);
alter table conversations add column if not exists reassigned_at timestamptz;

-- How the current assignee got the conversation (routing observability; see
-- assigned-via.sql, which is the same statement plus the queries that use it).
alter table conversations
  add column if not exists assigned_via text
  check (assigned_via in ('webhook', 'client_trigger', 'queue_pull', 'recovery_sweep', 'reassignment'));
