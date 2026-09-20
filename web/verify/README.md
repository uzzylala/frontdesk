# Verification suites

Browser-level checks that drive the real app against the real Supabase project: routing, presence and reassignment,
the widget, reconnect behaviour, accessibility, and how the UI fails. They are plain Node scripts with a small
`check()` harness (not a test framework), because most of what they do is orchestrate several browsers and the
database at once.

There are three layers of automated tests in this repo, each answering a different question:

| Layer | Run with | Proves | Needs |
|---|---|---|---|
| Unit | `npm test` | routing, least-busy selection, reassignment, the recovery sweep, announcement wording and batching, on an in-memory database | nothing |
| End to end | `npm run test:e2e` | the whole customer → agent → drop → reassignment flow, once | the app + database |
| **These suites** | `npm run verify` | everything else, in depth | the app + database (+ the widget host page, + the local API) |

## Running them

```
# terminals 1-2: the app and the local functions
VITE_ROUTING_TRIGGER=off npm run dev        # see "Two caveats", first one
# terminal 3: the demo page that embeds the widget (serves dist/widget.js)
npm run widget:demo

npm run verify:list                         # what exists, what each needs, how long it takes
npm run verify                              # the default set, ~35 minutes
npm run verify -- claim widget              # only suites whose name contains "claim" or "widget"
npm run verify -- --all                     # plus the slow and manual ones
```

The runner checks which servers are up and **skips (and fails the run) rather than guessing** when a prerequisite is
missing. It restores the database between suites, writes each suite's full output to `verify/.out/<suite>.log`, and
exits non-zero if anything failed or was skipped. A suite can also be run on its own:
`node --env-file=.env.local verify/suites/claim-outcomes.mjs`.

## Read this before running: these write to a real database

The free tier gives one Supabase project, so there is no separate test database. The suites create conversations, move
agents between statuses, delete heartbeats, and reassign the seeded demo conversations (they restore them afterwards).
Guard rails, in `lib.mjs`:

- **Pre-flight.** The runner refuses to start if the project holds an open conversation that is neither seed data
  (`supabase/seed.sql`) nor test data, so a real customer's conversation can't be touched. `VERIFY_FORCE=1` overrides.
- **Test data is named.** Everything a suite creates is called `A11y …`; cleanup deletes by that prefix, so it can never
  match anything else. Rows made by the customer page or the widget during a run are removed by name **and** by
  creation time (this run only). That sweep is a safety net for a suite that types a first message and doesn't record
  the id. Merely loading a page creates nothing, so the sweep reports any swept conversation that has **no message at
  all** as a ghost (a regression), separately from the ordinary ones.
- **Cleanup restores the seed** (each seeded conversation back to the "Agent" agent) and resets every agent to away,
  because a reaper sweep during a destructive test otherwise leaves the demo data reassigned.
- Credentials come from `web/.env.local` (the service-role key, to seed and clean up). They are never written into a
  suite; nothing here is machine-specific.

## Two caveats that will otherwise cost you an afternoon

1. **Local dev shares the production database, and production's webhooks fire for your local test data.** With
   `VITE_ROUTING_TRIGGER=client` (the `.env.development` default) an Online click makes the *browser* call
   `/api/agent-online` **and** the database webhook calls it too, so an agent is pulled two conversations, and
   whether the two calls collide or stagger is timing luck. That makes `routing-and-queue` pass roughly 1 run in 4 and
   `presence-and-reassignment` flaky. It is a property of this test setup (production has only the webhook), not an
   app bug: with `VITE_ROUTING_TRIGGER=off` the same suites pass consistently. Measured: 1 of 4 passes with both
   triggers; 3 of 4 with the webhook alone (the fourth was an unrelated page-load timeout).
2. **`setOffline()` does not test reconnect.** Playwright's `context.setOffline(true)` leaves an open Realtime
   WebSocket open, so a test built on it never exercises a reconnect. `realtimeChaos()` in `lib.mjs` proxies the socket
   so a test can genuinely sever and later restore it. Any new reconnect test should use it.

Also: the widget suites serve `dist/widget.js`, so **rebuild it (`npm run build:widget`) after changing widget code**;
a stale bundle makes a suite pass against code that no longer exists (this has happened, twice).

## The suites

| Suite | What it establishes |
|---|---|
| `routing-and-queue` | least-busy routing, the queue, "going online pulls the oldest", manual pickup, per-agent scoping |
| `presence-and-reassignment` | presence (intent vs liveness), "Connection lost" *before* reassignment, reassignment on disconnect, catch-up on reconnect |
| `widget-isolation` | the widget on a hostile host page (CSS, fonts, `rem`), works with the app **stopped** (needs the app down) |
| `a11y-axe` | axe-core (WCAG 2.2 A/AA + best practice), 0 violations over 6 states; `APP=https://… ` scans a deployment |
| `a11y-keyboard` | the keyboard-only path, tab order, focus management, checked with Chrome's accessibility tree |
| `a11y-announcements` | what the live region says and when: batching, suppression of own actions, presence and queue changes |
| `reconnect-roster` | other agents' statuses resync after the real WebSocket is severed and restored |
| `reconnect-missed-work` | assignments and customer messages missed during an outage are shown, counted and announced |
| `widget-first-message` | no "Loading conversation…" flash, no empty-state flicker, no duplicate on the first message |
| `scroll-to-newest`, `scroll-restore-position` | follows new messages, never yanks a reader who scrolled up, survives hidden panels |
| `claim-outcomes` | Pick up: claimed / lost / error, each with the right message and focus |
| `claim-race-focus-and-tie` | focus when the focused row is taken; a genuine manual-claim vs server-pull tie |
| `claim-race` (slow) | 400 simultaneous DB claims (one winner each), two consoles clicking at once |
| `error-recovery` | 9 injected failures (status save, history load, re-sync, widget lookup, first loads, send) |
| `loading-states` | every async operation shows a loading state, announced where appropriate, and clears |
| `lost-webhook-recovery` | a stranded conversation is routed by the sweep; a busy agent is *not* piled on |
| `pull-vs-sweep` | a stress test of the pull-versus-sweep race. It asserts only the hard invariants (nobody left with none, never more than two) and **reports** how often an agent ends with two (0 of 12 and 2 of 12 have both been seen), because it cannot separate "with the sweep's give-back" from "without" |
| `realtime-basic`, `realtime-multi-channel` | the Realtime layer (anon key) from the first phases |
| `background-tab` (manual) | a hidden real Chrome tab keeps heartbeating (the Web Worker ticker) |
| `deployed` (manual) | the same story against a deployment |

Not included: the NVDA screen-reader pass. It needs a portable NVDA install and a desktop session, so it isn't
automatable here; how it was done and what it found is in the top-level README ("Accessibility → How it was verified").
