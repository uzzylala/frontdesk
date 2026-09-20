// Verifies the DEPLOYED instance (Vercel + Supabase), not localhost.
//   PHASE=pre   webhooks NOT installed yet: presence/realtime/widget/reaper work; routing must NOT happen
//               (negative control: proves no browser-side routing workaround remains)
//   PHASE=post  webhooks installed: routing happens via Database Webhook only
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const APP = process.env.APP ?? 'https://frontdesk-sigma-mocha.vercel.app'
const HOST = 'http://localhost:5180' // demo host page on its own origin (cross-origin to the deployment)
const PHASE = process.env.PHASE ?? 'pre'
import { env, assertSafeToRun } from '../lib.mjs'
await assertSafeToRun()
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ZERO = '00000000-0000-0000-0000-000000000000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (label, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); if (ok) pass++; else fail++ }
async function until(fn, timeoutMs, intervalMs = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { try { const value = await fn(); if (value) return { ok: true, ms: Date.now() - t0, value } } catch { /* keep polling */ } await sleep(intervalMs) }
  return { ok: false, ms: Date.now() - t0, value: null }
}
const startedAt = new Date().toISOString()
async function reset() {
  await admin.from('agents').update({ status: 'away', last_assigned_at: null }).neq('id', ZERO)
  await admin.from('agent_heartbeats').delete().neq('agent_id', ZERO)
}
async function cleanup() {
  await admin.from('conversations').delete().in('customer_name', ['Demo Visitor', 'Customer']).gte('created_at', startedAt)
  await reset()
}

const routingCalls = [] // any browser->API routing request, from any page
const sweeps = []
function track(page, who) {
  page.on('response', async (r) => { if (r.url().includes('/api/reap-disconnected')) { const t = Date.now(); let body = ''; try { body = (await r.text()).slice(0, 160) } catch {} sweeps.push({ who, at: t, status: r.status(), body }) } })
  page.on('request', (r) => { if (/\/api\/(route-conversation|agent-online)/.test(r.url())) routingCalls.push(`${who}: ${r.method()} ${r.url()}`) })
}

async function openConsole(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  const page = await ctx.newPage()
  track(page, name)
  await page.goto(`${APP}/agent`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1:has-text("Who are you?")')
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`)
  return { ctx, page }
}
const chipState = (page, id) => page.locator(`[data-agent-id="${id}"]`).getAttribute('data-agent-state', { timeout: 1500 }).catch(() => null)
const sidebarIds = (page) => page.$$eval('[data-conversation-id]', (els) => els.map((e) => e.getAttribute('data-conversation-id')))
const assignee = async (id) => (await admin.from('conversations').select('assigned_agent_id').eq('id', id).single()).data?.assigned_agent_id

/** A visitor on a third-party page (own origin) embedding the DEPLOYED widget.js: one script tag, no dev opt-ins. */
async function visitorSendsViaWidget(browser, message) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await ctx.newPage()
  track(page, 'widget')
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.route(`${HOST}/`, async (route) => {
    const res = await route.fetch()
    let body = await res.text()
    body = body.replace('src="/widget.js"', `src="${APP}/widget.js"`)
      .replace('data-api-url="http://localhost:8787"', `data-api-url="${APP}"`)
      .replace(/\s*data-route-trigger="client"/, '')
    await route.fulfill({ response: res, body })
  })
  await page.goto(`${HOST}/`, { waitUntil: 'load' })
  const html = await page.content()
  check('host page embeds the DEPLOYED widget.js with no client-routing opt-in', html.includes(`${APP}/widget.js`) && !html.includes('data-route-trigger'))
  await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
  await page.click('frontdesk-widget button[aria-label="Open chat"]')
  await page.fill('frontdesk-widget input[placeholder="Type a message…"]', message)
  await page.click('frontdesk-widget form button[type="submit"]')
  await page.waitForSelector(`frontdesk-widget >> text=${message}`, { timeout: 15000 })
  await page.waitForSelector(`frontdesk-widget >> text=Sending…`, { state: 'detached', timeout: 15000 })
  const id = await page.evaluate(() => localStorage.getItem('frontdesk:widget:conversation-id'))
  return { ctx, page, id, errors }
}

async function main() {
  await cleanup()
  const { data: rows } = await admin.from('agents').select('id,name')
  const id = Object.fromEntries(rows.map((a) => [a.name, a.id]))
  const JORDAN = id['Jordan P.'], SAM = id['Sam K.']
  console.log(`Target: ${APP}   phase: ${PHASE}\n`)

  const browser = await chromium.launch()
  const jordan = await openConsole(browser, 'Jordan P.')
  const sam = await openConsole(browser, 'Sam K.')

  console.log('[1] Deployed console: Realtime + Presence + heartbeat')
  const seen = await until(async () => (await chipState(jordan.page, SAM)) === 'away', 20000)
  check('Jordan\'s console (deployed) sees Sam connected via Presence', seen.ok)
  await sam.page.click('button:has-text("online")')
  await jordan.page.click('button:has-text("online")')
  const online = await until(async () => (await chipState(jordan.page, SAM)) === 'online' && (await chipState(sam.page, JORDAN)) === 'online', 15000)
  check('status changes propagate live between deployed consoles', online.ok)
  await sleep(1500)
  const beats = (await admin.from('agent_heartbeats').select('agent_id')).data.map((b) => b.agent_id)
  check('both consoles heartbeat into Postgres through the deployed build (worker ticker)', beats.includes(SAM) && beats.includes(JORDAN), beats.length)

  console.log('\n[2] Embedded widget: deployed widget.js on a separate-origin host page')
  const v = await visitorSendsViaWidget(browser, `deployed widget ${PHASE} ${Date.now()}`)
  const conv = (await admin.from('conversations').select('*').eq('id', v.id).single()).data
  check('widget created its conversation straight in Supabase (no dependency on the app)', conv?.customer_name === 'Demo Visitor', conv?.customer_name)
  const cors = v.errors.filter((e) => /CORS|blocked|Content Security/i.test(e))
  check('no CORS/CSP console errors from the widget', cors.length === 0, cors)

  if (PHASE === 'pre') {
    console.log('\n[3] NEGATIVE CONTROL — webhooks not installed: routing must NOT happen')
    const routed = await until(async () => await assignee(v.id), 9000)
    check('with two agents online + heartbeating, the new conversation stays UNASSIGNED (nothing routes it)', !routed.ok, routed.value)
    check('and no browser made a routing API call (the dev-only workaround is gone from prod)', routingCalls.length === 0, routingCalls)

    console.log('\n[4] Widget realtime + presence-driven reassignment against the deployed API')
    const reply = `agent reply ${Date.now()}`
    await admin.from('messages').insert({ conversation_id: v.id, sender_type: 'agent', body: reply })
    const got = await v.page.waitForSelector(`frontdesk-widget >> text=${reply}`, { timeout: 10000 }).then(() => true, () => false)
    check('agent reply reaches the widget live', got)

    await admin.from('conversations').update({ assigned_agent_id: SAM }).eq('id', v.id) // setup: Sam holds it
    const samHas = await until(async () => (await sidebarIds(sam.page)).includes(v.id), 10000)
    check('(setup) conversation shows in Sam\'s sidebar', samHas.ok)
    await sam.ctx.close() // real tab close
    const t0 = Date.now()
    const disc = await until(async () => (await chipState(jordan.page, SAM)) === 'disconnected', 15000, 150)
    check(`Jordan sees Sam "Disconnected" (${(disc.ms / 1000).toFixed(1)}s)`, disc.ok)
    const tClose = t0; const moved = await until(async () => (await assignee(v.id)) === JORDAN, 40000, 500)
    check(`deployed reaper reassigned Sam's conversation to Jordan (${((Date.now() - t0) / 1000).toFixed(1)}s after close)`, moved.ok, await assignee(v.id))
    if (!moved.ok || process.env.SHOW_SWEEPS) for (const w of sweeps.filter((x) => x.at >= tClose)) console.log('     sweep', w.who, 't+' + ((w.at - tClose) / 1000).toFixed(1) + 's', w.status, w.body)
    const shown = await until(async () => (await jordan.page.locator(`[data-conversation-id="${v.id}"] [data-transferred-from="${SAM}"]`).count()) > 0, 10000)
    check('Jordan\'s sidebar marks it "Transferred from Sam K."', shown.ok)
  } else {
    console.log('\n[3] Routing via the Database Webhook (no browser-side call anywhere)')
    const t0 = Date.now()
    const routed = await until(async () => await assignee(v.id), 20000, 200)
    check(`new widget conversation was assigned by the webhook (${(routed.ms / 1000).toFixed(1)}s)`, routed.ok && [JORDAN, SAM].includes(routed.value), routed.value)
    check('assigned to the lowest agent id on the load tie (deterministic)', routed.value === [JORDAN, SAM].sort()[0], routed.value)
    const owner = routed.value === JORDAN ? jordan : sam
    const seenLive = await until(async () => (await sidebarIds(owner.page)).includes(v.id), 10000)
    check('conversation appears live in the assignee\'s console', seenLive.ok)
    check('no browser called /api/route-conversation or /api/agent-online', routingCalls.length === 0, routingCalls)
    void t0

    console.log('\n[4] agent-online webhook: an agent going online pulls the queue')
    await jordan.page.click('button:has-text("away")')
    await sam.page.click('button:has-text("away")')
    await until(async () => (await chipState(jordan.page, SAM)) === 'away', 8000)
    const q = await visitorSendsViaWidget(browser, `queued while offline ${Date.now()}`)
    await sleep(4000)
    check('with everyone away, the conversation stays queued', (await assignee(q.id)) === null, await assignee(q.id))
    await jordan.page.click('button:has-text("online")')
    const pulled = await until(async () => (await assignee(q.id)) === JORDAN, 20000, 200)
    check(`Jordan clicking Online pulled it via the agent-online webhook (${(pulled.ms / 1000).toFixed(1)}s)`, pulled.ok, await assignee(q.id))
    check('still no browser-side routing call', routingCalls.length === 0, routingCalls)

    console.log('\n[5] Standalone customer page (/) on the deployed app: routing + live two-way chat')
    await sam.page.click('button:has-text("online")')
    await sleep(1500)
    const cctx = await browser.newContext()
    const cp = await cctx.newPage()
    track(cp, 'customer')
    await cp.goto(`${APP}/`, { waitUntil: 'networkidle' })
    await sleep(1500)
    check('loading the customer page created no conversation', (await cp.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)))) === undefined)
    // The conversation is created by the first message, not by the page load.
    const msg = `customer says hi ${Date.now()}`
    await cp.fill('input[placeholder="Type a message…"]', msg)
    await cp.keyboard.press('Enter')
    const cid = await until(async () => cp.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v))), 10000)
    const routedC = await until(async () => await assignee(cid.value), 20000, 200)
    check('customer-page conversation routed by webhook', routedC.ok, routedC.value)
    const ownerC = routedC.value === JORDAN ? jordan : sam
    await until(async () => (await sidebarIds(ownerC.page)).includes(cid.value), 10000)
    await ownerC.page.click(`[data-conversation-id="${cid.value}"]`)
    const agentGot = await ownerC.page.waitForSelector(`text=${msg}`, { timeout: 10000 }).then(() => true, () => false)
    check('customer → agent message arrives live on the deployed app', agentGot)
    const back = `agent says hi ${Date.now()}`
    await ownerC.page.fill('input[placeholder="Type a message…"]:visible', back)
    await ownerC.page.keyboard.press('Enter')
    const custGot = await cp.waitForSelector(`text=${back}`, { timeout: 10000 }).then(() => true, () => false)
    check('agent → customer reply arrives live', custGot)
    check('customer page also made no browser-side routing call', routingCalls.length === 0, routingCalls)
  }

  await browser.close()
}
try { await main() } finally { await cleanup() }
console.log(`\n[${PHASE}] ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
