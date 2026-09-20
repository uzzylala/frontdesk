// Fix 4: the transcript must land on, and follow, the newest message — without yanking a reader who scrolled up.
import { chromium } from 'playwright'
import { admin, agents, cleanup, HOST, APP, openConsole, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const seed = async (name, n, extra = {}) => {
  const { data } = await admin.from('conversations').insert({ customer_name: name, ...extra }).select().single()
  ids.push(data.id)
  const base = Date.now() - n * 1000
  const rows = Array.from({ length: n }, (_, i) => ({
    conversation_id: data.id,
    sender_type: i % 3 === 2 ? 'agent' : 'customer',
    body: `${name} message ${i + 1} — a line long enough to wrap onto a second row in a narrow window, so the log really overflows`,
    created_at: new Date(base + i * 1000).toISOString(),
  }))
  await admin.from('messages').insert(rows)
  return data.id
}
const gap = (loc) => loc.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
const top = (loc) => loc.evaluate((el) => Math.round(el.scrollTop))
const overflow = (loc) => loc.evaluate((el) => el.scrollHeight > el.clientHeight + 50)

async function suite(label, page, log, input, sendUnread) {
  console.log(`\n=== ${label} ===`)
  check('setup: the transcript really overflows (test is meaningful)', await overflow(log))
  const g0 = await gap(log)
  check('opens scrolled to the newest message', g0 <= 4, `${g0}px above the bottom`)

  await sendUnread('live one')
  await sleep(1200)
  const g1 = await gap(log)
  check('a live message while at the bottom stays at the bottom', g1 <= 4, `${g1}px above the bottom`)

  await log.evaluate((el) => { el.scrollTop = 0 }) // reader scrolls to the top
  await sleep(300)
  await sendUnread('live two, while reading history')
  await sleep(1200)
  const t2 = await top(log)
  check('a reader who scrolled up is NOT yanked down by a new message', t2 <= 4, `scrollTop is ${t2}`)

  await input.fill('my own reply')
  await page.keyboard.press('Enter')
  await sleep(1500)
  const g3 = await gap(log)
  check('sending your own message brings you to the bottom', g3 <= 4, `${g3}px above the bottom`)
}

async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()

  // ---------- agent console
  const A = await seed('A11y Scroll A', 40, { assigned_agent_id: id['Agent'] })
  const B = await seed('A11y Scroll B', 40, { assigned_agent_id: id['Agent'] })
  const con = await openConsole(browser, 'Agent')
  await until(async () => (await con.page.$$('[data-conversation-id]')).length >= 7, 15000)
  await con.page.click(`[data-conversation-id="${A}"]`)
  await sleep(1200)
  const logA = con.page.locator('[role="log"][aria-label="Conversation with A11y Scroll A"]')
  const boxA = con.page.locator('form[aria-label="Send a message"]:visible input')
  await suite('agent console', con.page, logA, boxA, (t) => admin.from('messages').insert({ conversation_id: A, sender_type: 'customer', body: t }))

  console.log('\n--- console: switching conversations (inactive panels are display:none) ---')
  const logB = con.page.locator('[role="log"][aria-label="Conversation with A11y Scroll B"]')
  await con.page.click(`[data-conversation-id="${B}"]`)
  await sleep(800)
  check('a conversation opened for the first time (was hidden while loading) is at the bottom', (await gap(logB)) <= 4, `${await gap(logB)}px`)
  await con.page.click(`[data-conversation-id="${A}"]`)
  await sleep(800)
  check('switching back to a conversation you left at the bottom returns you to the bottom', (await gap(logA)) <= 4, `${await gap(logA)}px`)
  await admin.from('messages').insert({ conversation_id: B, sender_type: 'customer', body: 'arrives while B is hidden' })
  await sleep(1500)
  await con.page.click(`[data-conversation-id="${B}"]`)
  await sleep(800)
  check('a message that arrived while its panel was hidden is in view when you open it', (await gap(logB)) <= 4, `${await gap(logB)}px`)
  await con.ctx.close()

  // ---------- widget on the host page
  const W = await seed('Demo Visitor', 40)
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    await ctx.addInitScript((cid) => localStorage.setItem('frontdesk:widget:conversation-id', cid), W)
    const page = await ctx.newPage()
    await page.goto(`${HOST}/`, { waitUntil: 'load' })
    await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
    await page.click('frontdesk-widget button[aria-label="Open chat"]')
    await sleep(2500)
    const log = page.locator('frontdesk-widget [role="log"]')
    await suite('widget', page, log, page.locator('frontdesk-widget input[placeholder="Type a message…"]'), (t) => admin.from('messages').insert({ conversation_id: W, sender_type: 'agent', body: t }))
    await ctx.close()
  }

  // ---------- standalone customer page
  const C = await seed('Customer', 40)
  {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 800 } })
    await ctx.addInitScript((cid) => localStorage.setItem('frontdesk:customer-conversation-id', cid), C)
    const page = await ctx.newPage()
    await page.goto(`${APP}/`, { waitUntil: 'load' })
    await page.waitForSelector('[role="log"]')
    await sleep(2500)
    const log = page.locator('[role="log"]')
    await suite('customer page', page, log, page.locator('input[placeholder="Type a message…"]'), (t) => admin.from('messages').insert({ conversation_id: C, sender_type: 'agent', body: t }))
    await ctx.close()
  }
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
