// Loading-state audit: hold each operation's response for ~2.5s; the wait must be visible, and clear afterwards.
import { chromium } from 'playwright'
import { agents, makeConv, cleanup, HOST, APP, sidebarIds, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const DELAY = 2500
const slow = (flag, method) => async (route) => {
  if (flag.on && (!method || route.request().method() === method)) await sleep(DELAY)
  await route.continue()
}
const body = (p) => p.evaluate(() => document.body.innerText)
const seen = async (p, text, within = 2000) => (await until(async () => (await body(p)).includes(text), within, 100)).ok

async function newPage(browser, routes, vp = { width: 1300, height: 900 }) {
  const ctx = await browser.newContext({ viewport: vp })
  const page = await ctx.newPage()
  for (const [g, h] of routes) await page.route(g, h)
  return { ctx, page }
}

async function main() {
  await cleanup([])
  const id = await agents()
  const A = await makeConv({ customer_name: 'A11y Loading', assigned_agent_id: id['Agent'] }, [{ body: 'hello there' }])
  ids.push(A)
  const Q = await makeConv({ customer_name: 'A11y LoadQueued' }, [{ body: 'q' }])
  ids.push(Q)
  const browser = await chromium.launch()

  console.log('\n[1] Agent picker: agents list')
  {
    const f = { on: true }
    const { ctx, page } = await newPage(browser, [['**/rest/v1/agents*', slow(f, 'GET')]])
    await page.goto(`${APP}/agent`, { waitUntil: 'commit' })
    check('"Loading…" (role=status) is shown while agents load', (await seen(page, 'Loading…')) && (await page.locator('[role="status"]:has-text("Loading…")').count()) > 0)
    check('and replaced by the picker', (await until(async () => (await page.locator('h1:has-text("Who are you?")').count()) > 0, 8000)).ok)
    await ctx.close()
  }

  console.log('\n[2] Console: conversations + queue, message history')
  {
    const f = { on: false }
    const g = { on: false }
    const { ctx, page } = await newPage(browser, [['**/rest/v1/conversations*', slow(f, 'GET')], ['**/rest/v1/messages*', slow(g, 'GET')]])
    await page.goto(`${APP}/agent`, { waitUntil: 'load' })
    await page.waitForSelector('h1:has-text("Who are you?")')
    f.on = true
    g.on = true
    await page.click('button:has-text("Agent")')
    check('"Loading conversations…" (role=status) while the roster loads', (await seen(page, 'Loading conversations…')) && (await page.locator('[role="status"]:has-text("Loading conversations")').count()) > 0)
    await until(async () => (await sidebarIds(page)).includes(A), 15000)
    const hist = await until(async () => (await body(page)).includes('Loading conversation…') && (await page.locator('[role="log"][aria-busy="true"]').count()) > 0, 8000)
    check('the transcript says "Loading conversation…" and is aria-busy while history loads', hist.ok)
    check('then shows the messages', (await until(async () => (await body(page)).includes('hello there'), 8000)).ok)
    f.on = false
    g.on = false

    console.log('\n[3] Change status (save held)')
    const s = { on: true }
    await page.route('**/rest/v1/agents*', slow(s, 'PATCH'))
    await page.locator('input[name="agent-status"][value="busy"]').check({ force: true })
    check('the status control is aria-busy while saving', (await page.locator('fieldset[aria-busy="true"]').count()) > 0)
    check('and clears afterwards', (await until(async () => (await page.locator('fieldset[aria-busy="true"]').count()) === 0, 6000)).ok)
    s.on = false

    console.log('\n[4] Claim a queued conversation (PATCH held)')
    const c = { on: true }
    await page.route('**/rest/v1/conversations*', slow(c, 'PATCH'))
    await page.locator(`[data-queue-item-id="${Q}"] button`).focus()
    await page.keyboard.press('Enter')
    check('the button reads "Picking up…" while the claim is in flight', await seen(page, 'Picking up…', 1500))
    check('and is aria-disabled so a second click is ignored', (await page.locator(`[data-queue-item-id="${Q}"] button[aria-disabled="true"]`).count()) > 0)
    c.on = false
    await until(async () => (await sidebarIds(page)).includes(Q), 10000)

    console.log('\n[5] Send a message (POST held)')
    const m = { on: true }
    await page.route('**/rest/v1/messages*', slow(m, 'POST'))
    await page.click(`[data-conversation-id="${A}"]`)
    const box = page.locator('form[aria-label="Send a message"]:visible input')
    await box.fill('slow send')
    await page.keyboard.press('Enter')
    check('the message shows at once with "Sending…"', await seen(page, 'Sending…', 1200))
    check('and Send is disabled meanwhile', await page.locator('form[aria-label="Send a message"]:visible button[type="submit"]').isDisabled())
    check('"Sending…" clears when it lands', (await until(async () => !(await body(page)).includes('Sending…'), 8000)).ok)
    await ctx.close()
  }

  console.log('\n[6] Customer page: starting a conversation')
  {
    const f = { on: true }
    const { ctx, page } = await newPage(browser, [['**/rest/v1/conversations*', slow(f, 'POST')]], { width: 700, height: 800 })
    await page.goto(`${APP}/`, { waitUntil: 'commit' })
    check('"Connecting…" (role=status) while it starts', (await seen(page, 'Connecting…')) && (await page.locator('[role="status"]:has-text("Connecting")').count()) > 0)
    check('then the chat appears', (await until(async () => (await page.locator('input[placeholder="Type a message…"]').count()) > 0, 8000)).ok)
    const cid = await page.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)))
    if (cid) ids.push(cid)
    await ctx.close()
  }

  console.log('\n[7] Widget: history of a remembered conversation')
  {
    const W = await makeConv({ customer_name: 'Demo Visitor' }, [{ body: 'remembered message' }])
    ids.push(W)
    const f = { on: true }
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    await ctx.addInitScript((cid) => { if (!sessionStorage.getItem('s')) { localStorage.setItem('frontdesk:widget:conversation-id', cid); sessionStorage.setItem('s', '1') } }, W)
    const page = await ctx.newPage()
    await page.route('**/rest/v1/messages*', slow(f, 'GET'))
    await page.goto(`${HOST}/`, { waitUntil: 'load' })
    await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
    await page.click('frontdesk-widget button[aria-label="Open chat"]')
    const sr = () => page.evaluate(() => document.querySelector('frontdesk-widget').shadowRoot.textContent)
    check('"Loading conversation…" while the history loads', (await until(async () => (await sr()).includes('Loading conversation'), 3000, 100)).ok)
    check('then the message appears', (await until(async () => (await sr()).includes('remembered message'), 8000)).ok)
    await ctx.close()
  }
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
