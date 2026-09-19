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
web/src/widget/ the embeddable widget (own build: vite.widget.config.ts)
web/widget-demo/  a deliberately hostile fake company site that embeds it
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
- **Presence:** two signals, deliberately kept separate. *Intent* is
  `agents.status` (online/busy/away) — what the agent last clicked, persisted
  in Postgres. *Liveness* is Supabase Realtime Presence — whether their client
  is actually connected, held in Realtime's memory and shown instantly to
  every console. The UI combines them: a connected agent shows their intent;
  a disconnected one shows **Offline** if they'd set themselves away, or
  **Disconnected** if they never signed off (an unintentional drop).
- **Durable liveness:** serverless functions can't hold a socket to read
  Presence, so each console also heartbeats (every 5s, via an RPC that stamps
  the DB clock) into `agent_heartbeats`. An agent is "connected" server-side
  only if that heartbeat is under 15s old, and routing requires it — "online"
  means genuinely connected, not just last-clicked.
- **Background tabs:** browsers throttle `setInterval` in a hidden tab (Chrome
  cuts it to about one wake-up a minute), which would age a healthy console's
  heartbeat past the 15s limit and get its conversations reassigned. Measured:
  after ~90s hidden, the 5s heartbeat's gap grew to 73s and the conversation
  moved to the queue. The heartbeat and the sweep are therefore clocked by a
  dedicated Web Worker (`src/workers/ticker.worker.ts`; worker timers aren't
  throttled), and supabase-js's own socket keepalive runs in its `worker`
  mode. The same test with the fix holds a 6s max gap for 400s hidden. The
  widget deliberately doesn't use the Realtime worker: a host page's CSP may
  forbid blob workers.
- **Disconnect handling:** when a heartbeat goes stale, that agent's open
  conversations are automatically reassigned to the least-busy connected
  agent, or back to the queue if there isn't one. Automatic rather than
  flagged, because there are no admin roles to act on a flag and a customer
  waiting on a dead tab is the worst outcome; the 15s window is the grace
  period. Reassignment is a compare-and-set on the current assignee, so
  concurrent sweeps can't double-move, and `previous_agent_id` keeps an
  audit trail shown in the UI. Every connected console triggers the reaper
  (a nudge ~3s after seeing a Presence `leave`, plus a 10s sweep backstop);
  the server trusts only the heartbeat, so a wrong report can't kick a healthy
  agent. An agent who never connected is never reaped.
- **Widget isolation:** `widget.js` is a single IIFE that adds a
  `<frontdesk-widget>` custom element with an open shadow root and mounts
  React inside it. Tailwind's CSS is injected *inside* the shadow root, never
  into the host document. Four things get past a shadow boundary and are
  handled explicitly (`src/widget/shadowCss.ts`): Tailwind v4's `@property`
  rules are ignored in shadow trees (so borders/shadows silently vanish —
  hoisted to `:host` defaults); `rem` resolves against the *host page's*
  root font-size (converted to px); inherited properties cross the boundary
  (`all: initial` on the inner root); and the host element itself sits in the
  page's cascade (`!important` rules on `:host`, since inner-context
  `!important` beats outer). It opens its own Realtime subscription, talks
  to the same tables, and creates its conversation lazily on the first
  message so it never leaves ghost conversations from visitors who just
  loaded the page.

- **Routing:** a new conversation is assigned to the online agent with the
  fewest open conversations; ties go to whoever was assigned least recently,
  then to the lowest agent id (fully deterministic). No online agent means the
  conversation stays unassigned — that *is* the queue (`assigned_agent_id is
  null`). An agent going online is handed the oldest queued conversation.
  Going away/busy stops new routing but never strips existing assignments.
- **Where routing runs:** serverless, because it needs the service-role key
  and a single consistent view of agent load. In production it's triggered by
  Supabase Database Webhooks (`supabase/webhooks.sql`, pg_net triggers), which
  fire regardless of what created the row; the endpoints accept the webhook
  payload as well as a direct `{conversationId}` call. Locally there's no
  public URL for Supabase to call, so the browser calls the same endpoints
  instead — opt-in via `VITE_ROUTING_TRIGGER=client` (`.env.development`), so a
  production build can't quietly depend on it and mask a broken webhook.
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
5. To try the embeddable widget on the hostile demo host page:
   `npm run widget:demo` (builds `dist/widget.js` and serves the page on
   http://localhost:5180, on its own origin, with no dependency on the Vite app).

### Embedding

```html
<script src="https://your-host/widget.js"
        data-api-url="https://your-host"      <!-- where /api lives; defaults to the script's origin -->
        data-customer-name="Jane Doe"></script>  <!-- optional -->
```

### Known limitations

- A browser can freeze or discard a tab outright (e.g. Chrome's Memory Saver
  on a long-idle tab). Nothing, workers included, runs then, so the console is
  treated as disconnected and its conversations are reassigned. That is the
  right outcome for a console that has really stopped, but it means "left
  open in a tab" isn't a guarantee.
- Widget bundle is ~130 KB gzipped (React + supabase-js); aliasing to Preact
  would roughly halve it.

## Build phases

1. **MVP** — single conversation, one agent, Realtime message sync ✅
2. Multi-conversation agent console ✅
3. Routing/queue logic via serverless functions ✅
4. Widget isolation + presence/disconnect handling ✅
5. Realtime polish and accessibility
