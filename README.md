# Frontdesk

A live customer support chat and queue platform: an embeddable customer-facing
widget plus a separate agent console, built on Supabase Realtime (Postgres
logical replication) instead of a self-hosted socket server.

## Stack

- **Frontend:** React + TypeScript, Tailwind CSS, Zustand
- **Realtime:** Supabase Realtime (Postgres change data capture + Presence)
- **Database:** Supabase Postgres
- **Backend:** Vercel/Netlify serverless functions (routing, CRUD) — added in phase 3
- **Hosting:** Vercel or Netlify (frontend + functions), Supabase (DB + realtime)

## Layout

```
web/            agent console + embeddable widget (Vite)
web/api/        Vercel serverless functions (thin HTTP adapters)
web/server/     framework-agnostic routing logic + service-role client (server-only)
web/devserver.ts  local stand-in that serves web/api during `npm run dev`
supabase/       schema, seed data, and webhook definitions
```

## Architecture notes

- **Conversations ↔ channels:** each conversation is its own Realtime channel
  (`conversation:{id}`), subscribed via `postgres_changes` filtered server-side
  by `conversation_id`. An agent handling several conversations holds one
  subscription per conversation, so there is no client-side filtering and no
  cross-talk between chats by construction.
- **Presence:** Supabase's Realtime service is the always-on process — no
  server of ours needs to stay alive. Each agent client tracks its own status
  on a shared `presence:agents` channel for instant UI updates, and also
  upserts the same status into a Postgres `agents` table so stateless
  serverless functions (which can't hold a websocket open) can query "who's
  free?" when routing a new conversation.
- **Widget isolation:** the widget mounts inside a Shadow DOM custom element
  with its Tailwind CSS injected into the shadow root, so host-page styles
  can't leak in and widget styles can't leak out. It carries its own Supabase
  client and channel subscription, fully decoupled from the console.

- **Routing:** a new conversation is assigned to the online agent with the
  fewest open conversations; ties go to whoever was assigned least recently,
  then to the lowest agent id (fully deterministic). No online agent means the
  conversation stays unassigned — that *is* the queue (`assigned_agent_id is
  null`). An agent going online is handed the oldest queued conversation.
  Going away/busy stops new routing but never strips existing assignments.
- **Where routing runs:** serverless, because it needs the service-role key
  and a single consistent view of agent load. In production it's triggered by
  Supabase Database Webhooks (`supabase/webhooks.sql`), which fire regardless
  of what created the row. Locally there's no public URL for Supabase to
  call, so the client calls the same endpoints directly instead.
- **Known limitation:** there's no real auth yet. "Which agent am I" is a
  local picker, and every client uses the same anon key, so per-agent scoping
  is correct at the query level but not enforced by RLS.

## Local setup

1. Create a free [Supabase](https://supabase.com) project.
2. Run [`supabase/schema.sql`](supabase/schema.sql), then
   [`supabase/seed.sql`](supabase/seed.sql), in the SQL editor.
3. `cd web && cp .env.example .env.local` and fill in the project URL, anon
   key, and (server-only) service-role key.
4. `npm install && npm run dev` — starts Vite plus the local API server.
   Open `/` for the customer chat and `/agent` for the console.

## Build phases

1. **MVP** — single conversation, one agent, Realtime message sync ✅
2. Multi-conversation agent console ✅
3. Routing/queue logic via serverless functions ✅
4. Widget isolation + presence/disconnect handling
5. Realtime polish and accessibility
