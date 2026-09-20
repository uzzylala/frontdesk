// Shared helpers for the verification suites in ./suites. Nothing here is specific to one machine: the Supabase
// credentials come from the environment (web/.env.local via `node --env-file`, or read from that file as a fallback),
// and the URLs default to the local dev setup and can be overridden with APP / HOST / API.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')

function readEnvFile(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  } catch {
    return {}
  }
}
/** process.env wins; web/.env.local fills the gaps. */
export const env = { ...readEnvFile(path.join(WEB, '.env.local')), ...process.env }

export const APP = env.APP ?? 'http://localhost:5173'
export const HOST = env.HOST ?? 'http://localhost:5180' // the demo "hostile" host page that embeds the widget
export const API = env.API ?? 'http://localhost:8787'
export const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
export const SHOTS = path.join(HERE, '.out')
fs.mkdirSync(SHOTS, { recursive: true })

if (!env.VITE_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in web/.env.local, or the environment). The suites use the service role to seed and clean up data.')
}
export const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
/** A browser-equivalent client: the anon key, RLS applies. */
export const anonClient = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

export const NONE = '00000000-0000-0000-0000-000000000000'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------------------------
// assertions

let pass = 0
let fail = 0
export const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (ok) pass++
  else fail++
}
/** Prints the tally; returns the number of failures (for process.exit). */
export const summary = () => {
  console.log(`\n${pass} passed, ${fail} failed`)
  return fail
}

export async function until(fn, timeoutMs, intervalMs = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const value = await fn()
      if (value) return { ok: true, ms: Date.now() - t0, value }
    } catch {
      /* keep polling */
    }
    await sleep(intervalMs)
  }
  return { ok: false, ms: Date.now() - t0, value: null }
}

// ---------------------------------------------------------------------------------------------------------------
// data: seed, test rows, cleanup

/** The demo data the app ships with (supabase/seed.sql). Tests must leave it as they found it. */
export const SEEDED = ['Amara O.', 'Deji K.', 'Priya S.', 'Tom W.', 'Grace L.']
/** Every conversation a suite creates is named with this prefix so cleanup can never touch anything else. */
export const TEST_PREFIX = 'A11y '
/** Rows created by the customer page / widget during a run (their names come from the app, not from the test). */
const APP_CREATED = ['Customer', 'Demo Visitor']
export const RUN_START = Number(env.VERIFY_RUN_START ?? Date.now())

export async function agents() {
  const { data } = await admin.from('agents').select('id,name')
  return Object.fromEntries(data.map((a) => [a.name, a.id]))
}

/** Test conversations, named "A11y …". `messages` are backdated one second apart so ordering is deterministic. */
export async function makeConv(fields, messages = []) {
  const { data, error } = await admin.from('conversations').insert({ ...fields }).select().single()
  if (error) throw error
  const rows = messages.map((m, i) => ({
    conversation_id: data.id,
    sender_type: m.sender ?? 'customer',
    body: m.body,
    created_at: new Date(Date.now() - (messages.length - i) * 1000).toISOString(),
  }))
  if (rows.length) await admin.from('messages').insert(rows)
  return data.id
}

let preflightDone = false
/**
 * These suites write to the Supabase project the app points at (a single free-tier project: there is no separate
 * test database). Refuse to run if it holds conversations that are neither the seed data nor something a suite
 * makes, so a real customer's conversation can never be deleted, reassigned or "restored" by a test.
 */
export async function assertSafeToRun() {
  if (preflightDone || env.VERIFY_FORCE) return
  const { data } = await admin.from('conversations').select('id,customer_name,created_at').eq('status', 'open')
  const unknown = (data ?? []).filter((c) => !SEEDED.includes(c.customer_name) && !c.customer_name.startsWith(TEST_PREFIX) && !APP_CREATED.includes(c.customer_name))
  if (unknown.length) {
    console.error(`Refusing to run: ${unknown.length} open conversation(s) are neither seed data nor test data (${unknown.slice(0, 3).map((c) => c.customer_name).join(', ')}…). Set VERIFY_FORCE=1 to run anyway.`)
    process.exit(2)
  }
  preflightDone = true
}

/**
 * Puts the database back the way the suites found it: deletes the listed ids and anything with the test prefix,
 * deletes what the customer page / widget created during this run, resets every agent to away with no heartbeat
 * (a stale one would make the reaper move things), and restores the seeded conversations to their baseline
 * assignment (a reaper sweep during a destructive test otherwise leaves them reassigned).
 */
export async function cleanup(ids = []) {
  await assertSafeToRun()
  if (ids.length) await admin.from('conversations').delete().in('id', ids)
  await admin.from('conversations').delete().like('customer_name', `${TEST_PREFIX}%`)
  await admin.from('conversations').delete().in('customer_name', APP_CREATED).gte('created_at', new Date(RUN_START - 60_000).toISOString())
  await admin.from('agents').update({ status: 'away', last_assigned_at: null }).neq('id', NONE)
  await admin.from('agent_heartbeats').delete().neq('agent_id', NONE)
  const { data: ag } = await admin.from('agents').select('id,name')
  const agentId = ag?.find((a) => a.name === 'Agent')?.id
  if (agentId) {
    await admin.from('conversations').update({ assigned_agent_id: agentId, previous_agent_id: null, reassigned_at: null, status: 'open' }).in('customer_name', SEEDED)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// browser helpers

export async function openConsole(browser, name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, ...opts })
  const page = await ctx.newPage()
  await page.goto(`${APP}/agent`, { waitUntil: 'load' })
  await page.waitForSelector('h1:has-text("Who are you?")')
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`)
  return { ctx, page }
}

export async function runAxe(page, context) {
  if (!(await page.evaluate(() => typeof window.axe !== 'undefined'))) await page.addScriptTag({ path: AXE })
  return page.evaluate(
    async (ctx) =>
      window.axe.run(ctx ?? document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete'],
      }),
    context,
  )
}

export function reportAxe(label, res) {
  const v = res.violations
  console.log(`\n  [${label}] ${v.length} violation rule(s), ${res.incomplete.length} needing review, ${res.passes?.length ?? '?'} passed`)
  for (const r of v) {
    console.log(`     ✗ ${r.id} (${r.impact}) x${r.nodes.length}: ${r.help}`)
    for (const n of r.nodes.slice(0, 3)) console.log(`         ${n.target.join(' >> ')}  ${(n.failureSummary || '').split('\n').slice(1, 2).join(' ').trim().slice(0, 150)}`)
  }
  for (const r of res.incomplete) console.log(`     ? ${r.id} x${r.nodes.length}: ${r.help}`)
  return v.length
}

/** Focused element's role + accessible name, from Chrome's own accessibility engine (pierces open shadow roots). */
export async function focusedAx(page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Accessibility.enable')
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: '(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a === document.body ? null : a })()',
    })
    if (!result.objectId) return { role: '(none)', name: '', states: [] }
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false })
    const ax = nodes[0]
    const states = (ax.properties ?? [])
      .filter((p) => ['checked', 'expanded', 'disabled', 'current', 'selected', 'required'].includes(p.name) && p.value.value !== false && p.value.value !== 'false')
      .map((p) => `${p.name}=${p.value.value}`)
    return { role: ax.role?.value, name: ax.name?.value ?? '', states }
  } finally {
    await cdp.detach()
  }
}

/**
 * Playwright's context.setOffline() does NOT close an already-open Realtime websocket, so it cannot test reconnect.
 * This proxies the Supabase Realtime socket so a test can genuinely sever it (the page sees a 1006 close and
 * supabase-js starts its backoff) and later allow reconnects. HTTP is left alone. Install before the page navigates.
 */
export async function realtimeChaos(page) {
  let down = false
  let live = []
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    if (down) {
      ws.close({ code: 1006 })
      return
    }
    const server = ws.connectToServer()
    live.push({ ws, server })
  })
  return {
    async drop() {
      down = true
      for (const { ws, server } of live) {
        try { await server.close() } catch { /* already closed */ }
        try { await ws.close({ code: 1006 }) } catch { /* already closed */ }
      }
      live = []
    },
    restore() { down = false },
    get isDown() { return down },
  }
}

/** Records every change to the polite live region (console: light DOM; widget: inside the shadow root). */
export const SAMPLER = () => {
  window.__ann = []
  let last = ''
  const t0 = performance.now()
  setInterval(() => {
    const host = document.querySelector('frontdesk-widget')
    const root = host?.shadowRoot ?? document
    const region = root.querySelector('div[role="status"][aria-live="polite"][aria-atomic="true"]')
    const text = (region?.textContent ?? '').replace(/ /g, '') // the region alternates a trailing NBSP so repeats re-announce
    if (text && text !== last) window.__ann.push({ t: Math.round(performance.now() - t0), text })
    last = text
  }, 40)
}
export const heard = (page) => page.evaluate(() => window.__ann.slice())
export const resetHeard = (page) => page.evaluate(() => { window.__ann.length = 0 })

/** A console for `name`, with the live-region sampler and Realtime chaos installed before load. */
export async function openChaosConsole(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  await ctx.addInitScript(SAMPLER)
  const page = await ctx.newPage()
  const chaos = await realtimeChaos(page)
  await page.goto(`${APP}/agent`, { waitUntil: 'load' })
  await page.waitForSelector('h1:has-text("Who are you?")')
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`)
  return { ctx, page, chaos }
}

export const chipState = (page, id) => page.locator(`[data-agent-id="${id}"]`).getAttribute('data-agent-state', { timeout: 1500 }).catch(() => null)
export const sidebarIds = (page) => page.$$eval('[data-conversation-id]', (els) => els.map((e) => e.getAttribute('data-conversation-id')))
