// axe-core (WCAG 2.2 A/AA + best practice) over every state of the console, customer page and widget.
import { chromium } from 'playwright'
import { admin, agents, makeConv, cleanup, openConsole, runAxe, reportAxe, check, summary, APP, HOST, sleep, until } from '../lib.mjs'

// Local by default; `APP=https://… npm run verify -- a11y-axe` scans a deployment instead (bundle + deployed widget.js are checked).
const DEPLOYED = !APP.includes('localhost')
const ids = []
let total = 0
async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  if (DEPLOYED) {
    const html = await (await fetch(APP + '/agent')).text()
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    const bundle = js ? await (await fetch(APP + js)).text() : ''
    check('deployed bundle contains Part A AND Part B code', bundle.includes('Skip to conversations') && bundle.includes('aria-live') && bundle.includes('Some recent messages may be missing') && bundle.includes('is no longer in the queue'), js)
  }

  // --- picker (no agent chosen)
  {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${APP}/agent`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Who are you?")')
    total += reportAxe('agent picker', await runAxe(page))
    await ctx.close()
  }

  // --- console, populated: unread badge, transferred note, queue item with reassigned note
  ids.push(await makeConv({ customer_name: 'A11y Unread', assigned_agent_id: id['Agent'], previous_agent_id: id['Sam K.'] }, [{ body: 'Hello, my order has not arrived.' }]))
  ids.push(await makeConv({ customer_name: 'A11y Quiet', assigned_agent_id: id['Agent'] }, [{ body: 'Thanks for the help!' }]))
  ids.push(await makeConv({ customer_name: 'A11y Queued', previous_agent_id: id['Jordan P.'] }, [{ body: 'Anyone there?' }]))
  const con = await openConsole(browser, 'Agent')
  await until(async () => (await con.page.$$('[data-conversation-id]')).length >= 7, 15000)
  await sleep(1200)
  // an unread badge: a message lands in a background conversation
  const unreadConv = ids[0]
  await con.page.click(`[data-conversation-id="${ids[1]}"]`)
  await admin.from('messages').insert({ conversation_id: unreadConv, sender_type: 'customer', body: 'Are you still there?' })
  await until(async () => (await con.page.locator(`[data-conversation-id="${unreadConv}"]`).getAttribute('aria-label')).includes('unread'), 10000)
  total += reportAxe('console (unread, transferred, queued, all statuses)', await runAxe(con.page))

  // --- connection-lost banner
  await con.ctx.setOffline(true)
  await until(async () => await con.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 8000)
  total += reportAxe('console with "Connection lost" banner', await runAxe(con.page))
  await con.ctx.setOffline(false)
  await con.ctx.close()

  // --- customer page
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } })
    const page = await ctx.newPage()
    await page.goto(`${APP}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('input[placeholder="Type a message…"]')
    await page.fill('input[placeholder="Type a message…"]', 'Hi there')
    await page.keyboard.press('Enter')
    await page.waitForSelector('text=Hi there')
    total += reportAxe('customer page', await runAxe(page))
    const cid = await page.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)))
    if (cid) ids.push(cid)
    await ctx.close()
  }

  // --- widget on the hostile host page: closed, then open with a conversation. Host page itself is excluded.
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    if (DEPLOYED) await page.route(`${HOST}/`, async (route) => {
      const res = await route.fetch()
      const body = (await res.text()).replace('src="/widget.js"', `src="${APP}/widget.js"`).replace('data-api-url="http://localhost:8787"', `data-api-url="${APP}"`).replace(/\s*data-route-trigger="client"/, '')
      await route.fulfill({ response: res, body })
    })
    await page.goto(`${HOST}/`, { waitUntil: 'load' })
    if (DEPLOYED) check('widget host page loads the DEPLOYED widget.js', (await page.content()).includes(`${APP}/widget.js`))
    await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
    total += reportAxe('widget (closed)', await runAxe(page, { include: [['frontdesk-widget']] }))
    await page.click('frontdesk-widget button[aria-label="Open chat"]')
    await page.fill('frontdesk-widget input[placeholder="Type a message…"]', 'Question about billing')
    await page.keyboard.press('Enter')
    await page.waitForSelector('frontdesk-widget >> text=Question about billing')
    let v = []; await until(async () => ((v = (await admin.from('conversations').select('id').eq('customer_name', 'Demo Visitor')).data ?? []).length > 0), 10000) // the pending bubble shows the text before the row exists
    ids.push(...v.map((c) => c.id))
    if (v[0]) await admin.from('messages').insert({ conversation_id: v[0].id, sender_type: 'agent', body: 'Happy to help with that.' })
    await page.waitForSelector('frontdesk-widget >> text=Happy to help with that.')
    total += reportAxe('widget (open, conversation)', await runAxe(page, { include: [['frontdesk-widget']] }))
    await ctx.close()
  }

  await browser.close()
  check('axe: zero violations across all states', total === 0, `${total} violating rule(s)`)
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
