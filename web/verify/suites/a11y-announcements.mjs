// What the live region actually says, and when. A sampler inside the page records every change to the polite
// live region (console: light DOM; widget: inside the shadow root), so batching is measured, not assumed.
import { chromium } from 'playwright'
import { admin, agents, makeConv, cleanup, openConsole, check, summary, APP, HOST, sleep, until } from '../lib.mjs'

const SAMPLER = () => {
  window.__ann = []
  let last = ''
  const t0 = performance.now()
  setInterval(() => {
    const host = document.querySelector('frontdesk-widget')
    const root = host?.shadowRoot ?? document
    const region = root.querySelector('div[role="status"][aria-live="polite"][aria-atomic="true"]')
    const text = (region?.textContent ?? '').replace(/ /g, '')
    if (text && text !== last) window.__ann.push({ t: Math.round(performance.now() - t0), text })
    last = text
  }, 40)
}
const heard = (page) => page.evaluate(() => window.__ann.slice())
const reset = (page) => page.evaluate(() => { window.__ann.length = 0 })
const say = (list) => list.map((a) => `       +${(a.t / 1000).toFixed(1)}s  “${a.text}”`).join('\n')

const ids = []
async function main() {
  await cleanup([])
  const id = await agents()
  const A = await makeConv({ customer_name: 'A11y Unread', assigned_agent_id: id['Agent'] }, [{ body: 'first' }])
  const B = await makeConv({ customer_name: 'A11y Quiet', assigned_agent_id: id['Agent'] }, [{ body: 'hello' }])
  const Q = await makeConv({ customer_name: 'A11y Queued', previous_agent_id: id['Sam K.'] }, [{ body: 'anyone?' }])
  ids.push(A, B, Q)
  const ins = (cid, sender, body) => admin.from('messages').insert({ conversation_id: cid, sender_type: sender, body })

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  await ctx.addInitScript(SAMPLER)
  const page = await ctx.newPage()
  await page.goto(`${APP}/agent`, { waitUntil: 'networkidle' })
  await page.click('button:has-text("Agent")')
  await page.waitForSelector('h1:has-text("Agent")')
  await until(async () => (await page.$$('[data-conversation-id]')).length >= 7, 15000)
  const t0 = Date.now()
  await sleep(4000)

  console.log('\n[1] Opening the console announces nothing (existing inbox is not "news")')
  const onLoad = await heard(page)
  check('no announcement from initial load of 7 conversations, a queue and 4 agents', onLoad.length === 0, onLoad)
  void t0

  console.log('\n[2] One message')
  await reset(page)
  await ins(B, 'customer', 'single message')
  await until(async () => (await heard(page)).length >= 1, 6000)
  let h = await heard(page)
  console.log(say(h))
  check('one customer message → one announcement naming the customer', h.length === 1 && h[0].text === 'New message from A11y Quiet.', h)
  check('it arrives after the ~1.5s quiet window, not instantly', h[0]?.t >= 1200, h[0])

  console.log('\n[3] The agent\'s own reply is not announced')
  await sleep(2500); await reset(page)
  await ins(B, 'agent', 'my own reply')
  await sleep(3500)
  check('own reply: silence', (await heard(page)).length === 0, await heard(page))

  console.log('\n[4] A burst: 12 messages in ~3s from two conversations')
  await reset(page)
  for (let i = 0; i < 8; i++) { await ins(A, 'customer', `burst A ${i}`); await sleep(150) }
  for (let i = 0; i < 4; i++) { await ins(B, 'customer', `burst B ${i}`); await sleep(150) }
  await until(async () => (await heard(page)).length >= 1, 8000)
  await sleep(2500)
  h = await heard(page)
  console.log(say(h))
  check('12 messages → ONE announcement, not 12', h.length === 1, h.length)
  check('it summarises: total and per-customer counts', /12 new messages/.test(h[0]?.text) && /8 from A11y Unread/.test(h[0]?.text) && /4 from A11y Quiet/.test(h[0]?.text), h[0])

  console.log('\n[5] A sustained flood: a message every 400ms for 10s (never goes quiet)')
  await sleep(2500); await reset(page)
  const start = Date.now()
  let n = 0
  while (Date.now() - start < 10_000) { await ins(A, 'customer', `flood ${n++}`); await sleep(400) }
  await sleep(2600)
  h = await heard(page)
  console.log(`       ${n} messages sent`)
  console.log(say(h))
  check('a flood that never settles is still capped: bounded number of announcements (max-wait 6s)', h.length >= 2 && h.length <= 3, h.length)
  const total = h.reduce((sum, a) => sum + Number((/^(\d+) (?:new )?messages? /.exec(a.text) ?? [])[1] ?? 0), 0)
  check('and none is lost: announced counts add up to the messages sent', total === n, { total, n })

  console.log('\n[6] Conversation reassigned to you + queue change (batched into one sentence)')
  await sleep(2500); await reset(page)
  await admin.from('conversations').update({ assigned_agent_id: id['Agent'] }).eq('id', Q)
  await until(async () => (await heard(page)).length >= 1, 8000)
  await sleep(1500)
  h = await heard(page)
  console.log(say(h))
  check('says it was reassigned to you, from whom', /Conversation with A11y Queued reassigned to you from Sam K\./.test(h[0]?.text), h)
  check('and that the queue is empty', /Queue is now empty\./.test(h[0]?.text), h)
  check('as a single announcement', h.length === 1, h.length)

  console.log('\n[7] Presence: another agent connects, then drops')
  await sleep(2500); await reset(page)
  const jordan = await openConsole(browser, 'Jordan P.')
  await until(async () => (await heard(page)).length >= 1, 10000)
  await sleep(1500)
  h = await heard(page)
  console.log(say(h))
  check('Jordan connecting is announced', h.some((a) => /Jordan P\. is now Away\./.test(a.text)), h)
  await reset(page)
  await jordan.ctx.close()
  await until(async () => (await heard(page)).length >= 1, 15000)
  h = await heard(page)
  console.log(say(h))
  check('Jordan disconnecting is announced', h.some((a) => /Jordan P\. is now Offline\./.test(a.text)), h)
  check('none of it is assertive: the region is polite/atomic status', await page.evaluate(() => { const r = document.querySelector('div[role="status"][aria-live="polite"][aria-atomic="true"]'); return !!r && !document.querySelector('[aria-live="assertive"]') }))

  await ctx.close()

  console.log('\n[8] Widget (customer side): support replies, including while the widget is closed')
  const wctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await wctx.addInitScript(SAMPLER)
  const wp = await wctx.newPage()
  await wp.goto(`${HOST}/`, { waitUntil: 'load' })
  await wp.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
  await wp.click('frontdesk-widget button[aria-label="Open chat"]')
  await wp.fill('frontdesk-widget input[placeholder="Type a message…"]', 'I need help')
  await wp.keyboard.press('Enter')
  await wp.waitForSelector('frontdesk-widget >> text=I need help')
  // The pending bubble shows the text at once, before the row exists: wait for the row, not the text.
  let wc; await until(async () => (wc = (await admin.from('conversations').select('id').eq('customer_name', 'Demo Visitor')).data?.[0]?.id), 10000)
  ids.push(wc)
  await sleep(1200); await reset(wp)
  await ins(wc, 'customer', 'my own second message'); await sleep(3000)
  check('the visitor\'s own messages are not announced', (await heard(wp)).length === 0, await heard(wp))
  await wp.click('frontdesk-widget button[aria-label="Close chat"]')
  await sleep(300); await reset(wp)
  await ins(wc, 'agent', 'Hi, this is support — how can I help?')
  await until(async () => (await heard(wp)).length >= 1, 6000)
  h = await heard(wp)
  console.log(say(h))
  check('a reply while the widget is CLOSED is still announced, with its text', h.length === 1 && h[0].text === 'Support: Hi, this is support — how can I help?', h)
  await sleep(2000); await reset(wp)
  await ins(wc, 'agent', 'one'); await sleep(200); await ins(wc, 'agent', 'two'); await sleep(200); await ins(wc, 'agent', 'three')
  await until(async () => (await heard(wp)).length >= 1, 6000); await sleep(2000)
  h = await heard(wp)
  console.log(say(h))
  check('three quick replies → one announcement with the count and the latest', h.length === 1 && /^3 new messages from support\. Latest: three/.test(h[0].text), h)
  await wp.reload({ waitUntil: 'load' })
  await wp.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
  await sleep(3500)
  check('reloading the page does not re-announce old replies', (await heard(wp)).length === 0, await heard(wp))

  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
