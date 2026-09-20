import { chromium } from 'playwright'
import { admin, APP, HOST as HOST_ORIGIN, SHOTS, cleanup } from '../lib.mjs'

const HOST = `${HOST_ORIGIN}/`

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++ }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); fail++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls until fn() returns truthy; returns { ok, ms, value }. */
async function until(fn, timeoutMs, intervalMs = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const value = await fn()
      if (value) return { ok: true, ms: Date.now() - t0, value }
    } catch { /* keep polling */ }
    await sleep(intervalMs)
  }
  return { ok: false, ms: Date.now() - t0, value: null }
}

async function openConsole(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${APP}/agent`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1:has-text("Who are you?")')
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`)
  return { ctx, page }
}

const chipState = (page, agentId) =>
  page.locator(`[data-agent-id="${agentId}"]`).getAttribute('data-agent-state').catch(() => null)
const sidebarIds = (page) =>
  page.$$eval('[data-conversation-id]', (els) => els.map((e) => e.getAttribute('data-conversation-id')))
const queueIds = (page) =>
  page.$$eval('[data-queue-item-id]', (els) => els.map((e) => e.getAttribute('data-queue-item-id')))

/** A customer on the demo host page sends a first message through the widget. */
async function customerSendsViaWidget(browser, message) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(HOST, { waitUntil: 'load' })
  await page.click('frontdesk-widget button[aria-label="Open chat"]')
  await page.fill('frontdesk-widget input[placeholder="Type a message…"]', message)
  await page.click('frontdesk-widget form button[type="submit"]')
  await page.waitForSelector(`frontdesk-widget >> text=${message}`)
  await page.waitForSelector(`frontdesk-widget >> text=Sending…`, { state: 'detached' }) // the pending bubble shows the text before it is sent
  const id = await page.evaluate(() => localStorage.getItem('frontdesk:widget:conversation-id'))
  return { ctx, page, id }
}

async function main() {
  await cleanup()
  const { data: agentRows } = await admin.from('agents').select('id,name')
  const id = Object.fromEntries(agentRows.map((a) => [a.name, a.id]))
  const AGENT = id['Agent'], JORDAN = id['Jordan P.'], SAM = id['Sam K.']

  const browser = await chromium.launch()
  console.log('--- Three agent consoles: Agent (observer), Jordan, Sam ---')
  const obs = await openConsole(browser, 'Agent')
  const jordan = await openConsole(browser, 'Jordan P.')
  const sam = await openConsole(browser, 'Sam K.')

  console.log('\n[B1] Presence: connected agents show their INTENT, not "disconnected"')
  const allAway = await until(async () => {
    const s = await Promise.all([AGENT, JORDAN, SAM].map((a) => chipState(obs.page, a)))
    return s.every((x) => x === 'away') && s
  }, 15000)
  check('observer sees all three connected agents as "away" (they set nothing yet: status is intent)', allAway.ok, allAway.value)

  await jordan.page.click('label:has-text("online")')
  await sam.page.click('label:has-text("online")')
  const online = await until(async () => {
    const s = await Promise.all([JORDAN, SAM].map((a) => chipState(obs.page, a)))
    return s.every((x) => x === 'online') && s
  }, 15000)
  check('observer sees Jordan and Sam flip to "online"', online.ok, online.value)
  // heartbeat rows exist for connected consoles
  await sleep(1500)
  const beats = (await admin.from('agent_heartbeats').select('agent_id')).data.map((b) => b.agent_id)
  check('each connected console is heartbeating into Postgres', [AGENT, JORDAN, SAM].every((a) => beats.includes(a)), beats.length)

  console.log('\n[B2] Customers use the embedded widget; routing needs live agents')
  const custA = await customerSendsViaWidget(browser, `widget msg A ${Date.now()}`)
  const routedA = await until(async () => (await admin.from('conversations').select('assigned_agent_id').eq('id', custA.id).single()).data.assigned_agent_id, 10000)
  const custB = await customerSendsViaWidget(browser, `widget msg B ${Date.now()}`)
  const routedB = await until(async () => (await admin.from('conversations').select('assigned_agent_id').eq('id', custB.id).single()).data.assigned_agent_id, 10000)
  check('widget conversation A routed to Jordan (tie on load -> lowest id)', routedA.value === JORDAN, routedA.value)
  check('widget conversation B routed to Sam (now the least busy)', routedB.value === SAM, routedB.value)

  const samSees = await until(async () => (await sidebarIds(sam.page)).includes(custB.id), 10000)
  check('conversation appears live in Sam\'s sidebar', samSees.ok)
  const samPaneShowsMsg = await until(async () => sam.page.locator(`text=widget msg B`).first().isVisible(), 10000)
  check('Sam\'s chat pane shows the customer\'s first message WITHOUT clicking (default selection + no history race)', samPaneShowsMsg.ok)
  const reply = `reply from Sam ${Date.now()}`
  await sam.page.fill('input[placeholder="Type a message…"]:visible', reply)
  await sam.page.click('form button[type="submit"]:visible')
  const widgetGotReply = await until(async () => custB.page.locator(`frontdesk-widget >> text=${reply}`).first().isVisible(), 10000)
  check('Sam\'s reply reaches the embedded widget live', widgetGotReply.ok)

  const jordanSees = await until(async () => (await sidebarIds(jordan.page)).includes(custA.id), 10000)
  check('conversation A appears live in Jordan\'s sidebar', jordanSees.ok)
  await obs.page.screenshot({ path: `${SHOTS}/presence-1-all-online.png` })

  console.log('\n[B3] CLOSE Sam\'s tab -> "Disconnected" shown, conversation reassigned')
  const tClose = Date.now()
  await sam.page.close()
  const sawDisc = await until(async () => (await chipState(obs.page, SAM)) === 'disconnected', 30000, 200)
  check(`observer flips Sam to "disconnected" (not "offline"/"away") — took ${(sawDisc.ms / 1000).toFixed(1)}s after the tab closed`, sawDisc.ok)
  const samStatusDb = (await admin.from('agents').select('status').eq('id', SAM).single()).data.status
  check('...because Sam\'s intent (status) is still "online" — presence, not the toggle, drives this', samStatusDb === 'online', samStatusDb)
  await obs.page.screenshot({ path: `${SHOTS}/presence-2-sam-disconnected.png` })

  const moved = await until(async () => (await admin.from('conversations').select('*').eq('id', custB.id).single()).data.assigned_agent_id === JORDAN, 60000, 500)
  const tMoved = ((Date.now() - tClose) / 1000).toFixed(1)
  check(`Sam's conversation auto-reassigned to Jordan (${tMoved}s after the tab closed)`, moved.ok)
  const convB = (await admin.from('conversations').select('*').eq('id', custB.id).single()).data
  check('audit trail: previous_agent_id = Sam, reassigned_at set', convB.previous_agent_id === SAM && !!convB.reassigned_at, convB)
  const jordanGotIt = await until(async () => (await sidebarIds(jordan.page)).includes(custB.id), 10000)
  check('it shows up live in Jordan\'s sidebar', jordanGotIt.ok)
  const tag = await until(async () => jordan.page.locator(`[data-conversation-id="${custB.id}"] [data-transferred-from="${SAM}"]`).isVisible(), 5000)
  check('...tagged "Transferred from Sam K."', tag.ok)
  const jordanSeesHistory = await until(async () => {
    await jordan.page.click(`[data-conversation-id="${custB.id}"]`)
    return jordan.page.locator(`text=${reply}`).first().isVisible()
  }, 10000)
  check('Jordan sees the full history, including Sam\'s earlier reply (nothing lost in the handoff)', jordanSeesHistory.ok)
  await jordan.page.screenshot({ path: `${SHOTS}/presence-3-jordan-after-handoff.png` })

  console.log('\n[B4] KILL Jordan\'s network -> nobody left, conversations go to the queue')
  await jordan.ctx.setOffline(true)
  // Both clocks start together so we can assert the ORDER: the agent must be
  // warned before their conversations are taken away.
  const [banner, queued] = await Promise.all([
    until(async () => jordan.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 40000, 200),
    until(async () => {
      const rows = (await admin.from('conversations').select('id,assigned_agent_id,previous_agent_id').in('id', [custA.id, custB.id])).data
      return rows.length === 2 && rows.every((r) => r.assigned_agent_id === null && r.previous_agent_id === JORDAN) && rows
    }, 70000, 300),
  ])
  check(`Jordan's own console says "Connection lost" after ${(banner.ms / 1000).toFixed(1)}s`, banner.ok)
  check(`both of Jordan's conversations went back to the queue after ${(queued.ms / 1000).toFixed(1)}s`, queued.ok, queued.value)
  check('the agent is WARNED BEFORE their conversations are reassigned', banner.ok && queued.ok && banner.ms < queued.ms, { warnedMs: banner.ms, reassignedMs: queued.ms })

  const obsQueue = await until(async () => {
    const ids = await queueIds(obs.page)
    return ids.includes(custA.id) && ids.includes(custB.id)
  }, 10000)
  check('the observer\'s queue shows both', obsQueue.ok)
  const note = await until(async () => obs.page.locator(`[data-queue-item-id="${custA.id}"] [data-reassigned-from="${JORDAN}"]`).isVisible(), 5000)
  check('...each annotated "Reassigned — Jordan P. disconnected"', note.ok)
  const jordanChip = await until(async () => (await chipState(obs.page, JORDAN)) === 'disconnected', 60000, 500)
  check(`observer shows Jordan as "disconnected" too (${(jordanChip.ms / 1000).toFixed(1)}s)`, jordanChip.ok)
  await obs.page.screenshot({ path: `${SHOTS}/presence-4-queue-annotated.png` })

  console.log('\n[B5] Jordan\'s network returns -> reconnects, catches up, gets queued work')
  await jordan.ctx.setOffline(false)
  const back = await until(async () => (await chipState(obs.page, JORDAN)) === 'online', 90000, 500)
  check(`observer sees Jordan back to "online" (${(back.ms / 1000).toFixed(1)}s)`, back.ok)
  const bannerGone = await until(async () => !(await jordan.page.locator('[role="status"]:has-text("Connection lost")').isVisible()), 20000)
  check('Jordan\'s "connection lost" banner clears', bannerGone.ok)
  const jordanFinal = await until(async () => {
    const ids = await sidebarIds(jordan.page)
    return ids.length === 1 && ids
  }, 30000, 500)
  check('Jordan\'s sidebar caught up: NOT the stale 2 conversations — exactly 1, the oldest from the queue (online + reconnected -> pulled)', jordanFinal.ok, jordanFinal.value)
  check('...and it is the oldest queued one (A)', jordanFinal.value?.[0] === custA.id, jordanFinal.value)
  const obsQueueAfter = await until(async () => {
    const ids = await queueIds(obs.page)
    return ids.length === 1 && ids[0] === custB.id
  }, 10000)
  check('queue now holds just B, still annotated as reassigned', obsQueueAfter.ok)
  await obs.page.screenshot({ path: `${SHOTS}/presence-5-recovered.png` })

  console.log('\n[B6] The seeded demo data was never disturbed')
  const demoStill = (await admin.from('conversations').select('id').eq('assigned_agent_id', AGENT).eq('status', 'open')).data.length
  check('Agent (never disconnected during the test) still holds their 5 demo conversations', demoStill === 5, demoStill)

  await browser.close()
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('FAILED', e); await cleanup(); process.exit(1) })
