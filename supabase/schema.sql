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

-- Phase 1 has a single agent, no auth/roles yet (multi-agent, presence, and
-- identity land in later phases). This table exists now mainly to establish
-- the shape; nothing reads it yet.
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

insert into agents (name)
select 'Agent'
where not exists (select 1 from agents);

-- Realtime needs the table registered on the supabase_realtime publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table messages;
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
