-- Frontdesk — Phase 1 schema
-- Run this in the Supabase SQL editor (or via the CLI) on a fresh project.

create extension if not exists "pgcrypto";

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  sender_type text not null check (sender_type in ('customer', 'agent')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_created_at_idx
  on messages (conversation_id, created_at);

-- Realtime needs the table registered on the supabase_realtime publication.
alter publication supabase_realtime add table messages;

alter table conversations enable row level security;
alter table messages enable row level security;

-- Phase 1 has no auth yet (widget/console split and agent identity come later
-- phases), so policies are intentionally permissive for anon access to keep
-- the MVP demo-able end to end. These get scoped down once agent auth lands.
create policy "anon can read conversations" on conversations
  for select to anon using (true);

create policy "anon can create conversations" on conversations
  for insert to anon with check (true);

create policy "anon can read messages" on messages
  for select to anon using (true);

create policy "anon can insert messages" on messages
  for insert to anon with check (true);
