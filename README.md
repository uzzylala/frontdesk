# Frontdesk

A live customer support chat and queue platform: an embeddable customer-facing
widget plus a separate agent console, built on Supabase Realtime (Postgres
logical replication) instead of a self-hosted socket server.

**Live:** [customer page](https://frontdesk-sigma-mocha.vercel.app/) ·
[agent console](https://frontdesk-sigma-mocha.vercel.app/agent) ·
[a third-party site embedding the widget](https://widget-demo-site-delta.vercel.app/)
(deployed separately, on its own domain, so the embed is genuinely
cross-origin — see `widget-demo-site/`). All three talk to the same shared
Supabase project; there's no tenant separation yet, so anything sent from any
of them is visible to the two demo agents in one shared queue.

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
web/widget-demo/  the fake company site, wired to localhost (npm run widget:demo)
widget-demo-site/ the same page wired to the deployed widget.js + API instead;
                 its own Vercel project/domain, not built by web/ — redeploy with
                 `vercel deploy widget-demo-site --prod`
web/api/        Vercel serverless functions (thin HTTP adapters)
web/server/     framework-agnostic routing logic + service-role client (server-only)
web/devserver.ts  local stand-in that serves web/api during `npm run dev`
web/tests/unit/ unit tests (vitest) on an in-memory database
web/e2e/        the Playwright end-to-end test
web/verify/     the browser-level verification suites and their runner
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
  throttled). The same test with the fix holds a 6s max gap for 400s hidden.
  supabase-js's own socket keepalive is also a main-thread timer, so it runs in
  the library's `worker` mode too — but a control run with only that turned
  off also stayed connected for 400s, so the heartbeat worker is the part
  that matters there; the Realtime one is cheap insurance for longer hidden
  periods. The widget deliberately skips it: a host page's CSP may forbid
  blob workers.
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
  loaded the page. The standalone customer page works the same way (both use
  one hook, `useLazyConversation`): it originally created a conversation on
  load, so every visit, including bots and people who never typed, left an
  empty conversation in the queue and had it routed to an agent. Now loading
  creates nothing, and a returning visitor's remembered conversation is only
  *looked up*, where a failed lookup is an error with "Try again" rather than
  being read as "none" (which would have started a second conversation and
  orphaned the first). The trade-off: the first message is now two round trips
  (create the conversation, then insert the message), so if the second fails the
  conversation exists with no message. The visitor's draft is kept and a retry
  reuses that conversation instead of creating another.

- **Accessibility:** built for keyboard and screen-reader use, and checked with
  a real screen reader (see "How it was verified").
  - *Semantics.* The console has real landmarks (banner, main, a labelled
    conversations `nav` holding a `ul`), each page has its own `<title>`, the
    status control is a native radio group (fieldset + legend), each
    conversation-list item's accessible name carries who, unread count,
    "transferred from …", connection trouble and the last message (the coloured
    badge is decoration), and each transcript is a `role="log"` with
    `aria-live="off"` so it's navigable but never speaks on its own.
  - *Keyboard.* Tab order: skip links ("Skip to conversations", "Skip to message
    box") → Switch agent → status (one stop; arrows change it) → queue
    "Pick up" buttons → conversation list → transcript → message box. Enter on a
    conversation opens it and moves focus to its message box; Escape in the box
    returns to the list; claiming from the queue lands you in that
    conversation's box. Choosing or switching agent moves focus to the new
    view's heading instead of dropping it on `<body>`. The widget moves focus
    into its box on open, back to its launcher on close, and closes on Escape.
    One `:focus-visible` ring everywhere (also inside the widget's shadow root).
  - *Announcements* go through one polite, atomic live region mounted at the
    page root — not one per component, because the console's inactive
    conversations are `display: none`, where a live region is never spoken.
    Producers only emit facts (`lib/consoleEvents.ts`); one hook batches them
    (1.5s quiet window, 6s maximum wait, `lib/announcementBatcher.ts`) and words
    them (`lib/formatAnnouncements.ts`): "12 new messages: 8 from Amara O. and
    4 from Deji K.", "Conversation with Tom W. reassigned to you from Sam K.",
    "Jordan P. is now Disconnected", queue size changes. Live events only —
    opening the console reads out nothing — and never your own replies or your
    own queue claims. Customers (page and widget) hear "Support: …" for replies,
    including while the widget is closed. "Message sent" confirms a send.
  - *Contrast.* axe's WCAG 2.2 AA colour-contrast rule passes in every state
    tested (non-text contrast of borders was checked by hand). The old `slate-400` secondary text
    (2.6:1) is `slate-500/600`; white-on-`emerald-600/amber-500/slate-400`
    status pills are `emerald-700/amber-700/slate-600`; control borders are
    `slate-500` (3:1+ non-text contrast).
  - *How it was verified* (Chrome, Windows). **axe-core 4.13** (WCAG 2.2 A/AA +
    best practice) over the agent picker, the populated console (unread,
    transferred and queued items), the "Connection lost" banner, the customer
    page, and the widget closed / open-empty / open-with-conversation: 0
    violations; the same scan on the pre-change build found 13 elements failing
    contrast plus missing `main`/landmarks, and on the old widget one contrast
    failure in its empty state. A **keyboard-only** walkthrough (21 checks: pick
    an agent, tab order, skip links, open a conversation, send, Escape, change
    status with arrows, claim from the queue). Timed **announcement** checks (a
    12-message burst is one announcement; a 10s flood that never goes quiet is
    two, and their counts add up to every message). And a pass with **NVDA
    2026.2** (silent synthesizer, speech captured from its log) driving real
    Chrome, e.g. "Your status, grouping / Away, radio button, checked, 3 of 3",
    "Conversations, navigation landmark, list, with 7 items … button, current",
    "A11y Unread, 11 unread messages, transferred from Sam K., last message:
    burst 9, button", "10 new messages from A11y Unread.", "Open chat, button,
    collapsed".
  - *Not covered.* NVDA + Chrome only: not VoiceOver, JAWS, TalkBack or Firefox.
    NVDA was driven with synthetic keyboard events over CDP rather than a
    physical keyboard, and automated checks catch only part of what a person
    would. Not a substitute for testing with users who rely on these tools.
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
- **A lost routing trigger is recovered** by the 10s sweep, for idle agents only,
  and the recovery is tagged so it can be counted — see "Resilience decision"
  below.
- **Reconnects and failures** (verified by severing the real Realtime
  WebSocket and by injecting request failures, not by assumption). Realtime
  doesn't replay what it missed, so each hook re-reads on its own
  re-subscribe: agent statuses, assignments and missed customer messages are
  caught up, and — through the same live region as anything live — spoken.
  A failed *re*-sync keeps the stale-but-real console on screen with a quiet
  notice and retries with backoff; only a failed *first* load blocks the view,
  and it has a Try again button. A failed history load is its own state (not
  "No messages yet"). The widget never treats a failed lookup of the visitor's
  saved conversation as "none", so a network blip can't start a second one. A
  Pick up click has three outcomes (claimed / lost / error) with a message and
  focus for each; the claim itself is an atomic compare-and-set (400
  simultaneous claims: exactly one winner every time).
- **Known limitation:** there's no real auth yet. "Which agent am I" is a
  local picker, and every client uses the same anon key, so per-agent scoping
  is correct at the query level but not enforced by RLS.

### Resilience decision: recovering from a lost routing webhook

**The failure mode.** Routing is event-driven: a Postgres trigger calls a
serverless function when a conversation is inserted (`supabase/webhooks.sql`).
pg_net delivery is asynchronous and fire-and-forget by design, so a call can be
lost or fail (function error, cold start past the timeout, an outage) and
*nothing retries it*. The conversation then sits in the queue indefinitely,
while an agent who is online, connected and idle looks on and the customer
waits. I reproduced exactly this state and measured it: still queued after 46s,
with no trigger that would ever fire again.

**The decision.** Every console already runs a `reap-disconnected` sweep every
10s. That sweep now also calls `routeStrandedQueue`, which routes conversations
that have sat in the queue for 15s or more, oldest first, through the *same*
`assignNewConversation` compare-and-set the webhook uses. Two consequences of
reusing it: racing the webhook (or another console's sweep) can't double-assign,
and no new infrastructure is needed (a cron job, a queue, a second service).
The 15s age gate means the sweep is a backstop that never races the primary
path for a fresh conversation. Measured recovery: **~25s** (the gate plus at
most one sweep interval).

**Why it is bounded to idle agents only.** The sweep assigns only to an agent
who is online, connected, and has *nothing open*. This is deliberate, not a
shortcut. An agent who comes online is specified to be handed just the oldest
queued conversation, and "queued conversation + online agent" is the same
database state whether a webhook was lost or a backlog is simply waiting. An
unrestricted sweep can't tell them apart, and my first version drained the
whole backlog onto whoever was online, which broke that rule (and failed the
phase 4 suite). Restricting it to idle agents rescues the case that matters
(nobody is working while a customer waits) without silently changing routing
semantics. "Idle?" and "assign" are two statements, so a queue pull can land in
between; the sweep therefore re-counts after its own assignment and gives it
back if the agent now has more than one. The pull is never undone, so it always
wins the tie.

**Known limitation.** If every online agent already has something open, a
stranded conversation is *not* rescued: it waits for a manual pickup or for the
next agent to come online. The fallback is weaker than the primary path, which
would have given it to the least-busy agent regardless of load. Closing that gap
means deciding that a waiting backlog should draw down onto busy agents, which is
a product decision about the queue, not a resilience tweak, so it is left open.

**It is observable, not silent.** Each server-side assignment is logged as
`{"event":"routing","via":...}` and tagged in `conversations.assigned_via`
(`webhook`, `client_trigger`, `queue_pull`, `recovery_sweep`, `reassignment`;
manual pickups, which happen in the browser, stay `NULL`; apply
`supabase/assigned-via.sql` once — until then the code just warns and routing is
unaffected). That makes "how often is the webhook actually failing?" a query
rather than a guess (it is in `assigned-via.sql`): among never-reassigned
conversations, the share tagged `recovery_sweep` versus `webhook`. Read it with
its caveats: it *under*-counts (a lost webhook whose conversation an agent picked
up by hand first is tagged `NULL`), the tag is the latest assignment rather than a
history, and the function logs that carry the event stream are short-lived on
Vercel's free plan.

**The concurrency safeguard is correlational, not proven, and only covers one ordering.**
"Is the agent idle?" and "assign" are two statements, so the sweep and a queue pull
(an agent coming online) can interleave, in two ways. If the pull lands first and
the sweep second, the sweep's re-count sees two and gives its own back; that is
the case the safeguard handles. If the *sweep* fills the idle agent first and the
pull lands second, nothing undoes the pull (by design), so the agent ends with two
conversations instead of one. That is benign (a queued customer reaches an agent
sooner) but it is not the specified one-pull rule, and it is not prevented; an
occasional "two" is a known outcome.

The give-back was added after the phase 4 reconnect check failed in 2 of 3 runs; it
passed 3 of 3 (28/28) afterwards. That is an observed correlation. A dedicated stress
test of the race (`web/verify/suites/pull-vs-sweep.mjs`) has not confirmed the safeguard's
effect: it gave 12/12 correct results with *and* without the change, and later 2
"two" outcomes in 12 with it, so the outcome varies run to run and the test cannot
separate the two arms. Unit tests do pin the *logic*: given the interleaving
"pull lands right after the sweep's write", the give-back fires (and the suite goes
red if it is removed). What no test shows is how often that interleaving happens in
production. Treat the safeguard as reasoned and unit-tested, not empirically
confirmed, until an experiment reproduces the race without it. The stress test
therefore asserts only the hard invariants (nobody left with none, never more than
two, no lost customer) and reports the rate of two.

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

### Deploying (Vercel)

1. From `web/`: `npx vercel link`, set the Production env vars
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and (sensitive)
   `SUPABASE_SERVICE_ROLE_KEY`, then `npx vercel deploy --prod`. The project
   root is `web/`: `vercel.json` handles the SPA rewrite and serves
   `/widget.js`, and `api/*.ts` become the serverless functions. (If you
   connect a Git repository, set the project's Root Directory to `web`,
   otherwise every push builds from the repo root and fails.)
2. Run [`supabase/webhooks.sql`](supabase/webhooks.sql) in the SQL editor (edit
   its two URLs if your domain differs). From then on Postgres itself calls
   `/api/route-conversation` on every new conversation and `/api/agent-online`
   when an agent goes online. Nothing in the browser does.
3. Embed on any site with the snippet below, pointing at your domain.

### Verifying that routing is webhook-driven

In production the browser never calls `/api/route-conversation` or
`/api/agent-online`; Postgres does, through the triggers in
`supabase/webhooks.sql`. Three ways to check that yourself, from independent
vantage points:

1. **Browser side.** Open DevTools → Network, filter on `api/`, then use the
   app (start a chat on `/`, click Online in `/agent`). The only `/api/` request
   you'll ever see is `reap-disconnected` (the reaper sweep). There is no
   `route-conversation` and no `agent-online`.
2. **Server side.** Each routing invocation logs one line saying who called.
   A browser's JSON POST always carries an `Origin` header; a Postgres webhook
   sends none and identifies itself as `pg_net`:

   ```
   npx vercel logs --since 5m --json | grep '"fn"'
   {"fn":"route-conversation","caller":"server","origin":null,"userAgent":"pg_net/0.20.4","payload":"webhook"}
   ```

   `caller: "browser"` would show the page's origin instead. Any such line
   means something in a page is still triggering routing.
3. **No browser at all.** `npm run verify:webhooks` (from `web/`) drives the
   whole thing through the Supabase API: it inserts a conversation, then sets
   an agent online with a queue waiting, and asserts the right agent got the
   right conversation. Nothing but the database can have called the endpoints.
   Run (1) or (2) alongside it.

Measured on the deployed app: a conversation inserted straight into Postgres
was assigned 0.7–2s later (~5s on a cold function); an agent going online was
handed the oldest of three queued conversations in about 2s and the other two
stayed queued. Server logs for those runs showed every routing call as
`caller: "server"` with a `pg_net` user-agent, zero `browser`; a deliberately
browser-like control request was labelled `caller: "browser"`, so the
instrument does discriminate.

### Embedding

```html
<script src="https://your-host/widget.js"
        data-api-url="https://your-host"      <!-- where /api lives; defaults to the script's origin -->
        data-customer-name="Jane Doe"></script>  <!-- optional -->
```

### Tests and verification

Four layers, each answering a different question (details and caveats in
[`web/verify/README.md`](web/verify/README.md)):

| Layer | Command | What it establishes |
|---|---|---|
| Unit | `npm test` | The real routing code (`server/routing.ts`) on an in-memory database: least-busy selection and its tie-breaks, compare-and-set assignment, the queue pull, reassignment on disconnect, the recovery sweep and its give-back, plus announcement wording and batching. 40 tests, no network. |
| End to end | `npm run test:e2e` | One Playwright test of the whole product: a customer starts a chat → it routes to an online agent → the agent replies → that agent's connection dies → the conversation is reassigned to the other agent, who is told → they reply → the customer sees one unbroken thread. |
| Verification suites | `npm run verify` | 19 suites in the default set (22 in all, counting the slow and manual ones): routing, presence, the widget, reconnects, accessibility, failure and loading states, races, against the real app and database. ~35 minutes. |
| Checks | `npm run check:env`, `npm run lighthouse` | Secret scoping (below) and Lighthouse (below). |

How much to trust the tests: the unit suite was **mutation-tested** — I broke
`routing.ts` eight deliberate ways (most-busy wins, no compare-and-set on assign or
on reassign, heartbeat staleness ignored, the queue pull taking the newest, the
sweep not restricted to idle agents, the give-back removed, the age gate removed)
and it failed each time. The first pass caught only 7 of 8: removing the idle
restriction changed nothing observable, because the give-back undid the pile-on
afterwards, so a test now asserts that no write happens at all. The E2E was checked
the same way: with the local functions (and so the reaper) unavailable it fails at
exactly the reassignment step. The verification suites write to the real Supabase
project (there is no separate test database on the free tier), so they refuse to
run if it holds anything that isn't seed or test data, and restore the seed after
every suite.

**Secret scoping** (`npm run check:env`, 24 checks, never prints a secret). The
service-role key bypasses RLS entirely, so the question is everywhere it could
leak: tracked files (it isn't there; the one tracked env file holds nothing
secret), **git history across every branch** (never committed), the client source
(`src/` never reads it; only `server/supabaseAdmin.ts` does), the local build, the
**deployed** app and `widget.js` (scanned as served: the widget carries the
low-privilege anon key and nothing stronger), Vercel's variables (the service key is
a `Secret`-type variable scoped to Production only, with no `VITE_` twin that would
inline it into the bundle), and the API's error responses. The scanner has a
positive control (it must find a planted key, an `sb_secret_` token and a
`service_role` JWT), because "nothing found" means nothing from a scanner that can't
find anything. One thing this exercise did surface: three of my own scratch test
scripts had the service key hard-coded. They were never committed (checked), and
porting them into the repo meant reading credentials from the environment instead.

**Lighthouse** (`npm run lighthouse`; mobile = emulated Moto G on slow 4G, and
desktop), measured against the **deployed** app; the widget host page is the local
demo page (compressed) loading the widget bundle.

| Page | Form | Perf | A11y | Best practices | SEO |
|---|---|---|---|---|---|
| Customer page | mobile / desktop | 99 / 100 | 100 / 100 | 100 / 100 | 100 / 100 |
| Agent console | mobile / desktop | 94 / 100 | 100 / 100 | 100 / 100 | 63 / 63 |
| Widget on a host page | mobile / desktop | 99 / 100 | 88 / 88 | 100 / 100 | 90 / 90 |

Reading the numbers rather than quoting them: the agent console's SEO of 63 is the
intended result of `robots.txt` disallowing `/agent` (Lighthouse flags "page is
blocked from indexing"), not a defect. The widget host page's accessibility 88 is
the demo page's own markup (an unlabelled input, low-contrast text, no `<main>`);
none of the failing nodes is inside the widget, which adds 0 failures (also
confirmed by axe). Three real findings were fixed: the app had no meta description
or `robots.txt` (SEO 82 → 100 on the customer page); the local demo server served
the 448 KB widget uncompressed, which made the host page's mobile performance look
like 81 instead of 98 (production serves it as ~130 KB gzip); and the customer
page created a conversation on every load, which the script had to delete
afterwards, and which was skipped when Chrome's temp-profile deletion failed on
Windows. That was the app's bug, not the script's: the page now creates nothing until
a message is sent, the script's cleanup is gone, and it instead fails if any
conversation appears while only loading pages. The
remaining cost is `unused-javascript` (React + supabase-js), which I haven't tried
to reduce. Performance scores vary from run to run: the customer page's mobile score
was 88, 98, 89, 94 (local build) and finally 99 across five runs, and its desktop score
100 in all but one (86, on a 300 ms blocking-time blip). Read them as a band, not a
point; the table is the last run against the deployed app, after the ghost-conversation
fix, and accessibility, best-practices and SEO were stable in every run.

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
5. Realtime polish and accessibility — accessibility ✅, real-time edge cases and error recovery ✅, final checks (Lighthouse, secret scoping, unit tests, E2E, reproducible verification suites) ✅
