// Fix 3: sending the FIRST message in the widget creates the conversation lazily. The transcript must not flash
// "Loading conversation…" (and must not announce it) in between, nor fall back to "No messages yet" while the
// message the visitor just sent is in flight. A recorder inside the shadow root logs every state the transcript
// passes through (per animation frame, with timestamps), so the flash is measured rather than eyeballed.
import { chromium } from 'playwright'
import { admin, cleanup, HOST, SAMPLER, heard, check, summary, sleep } from '../lib.mjs'

const RECORDER = () => {
  window.__states = []
  const t0 = performance.now()
  let last = ''
  const tick = () => {
    const root = document.querySelector('frontdesk-widget')?.shadowRoot
    const log = root?.querySelector('[role="log"]')
    if (log) {
      const text = log.textContent.trim()
      const state = /Loading conversation/.test(text) ? 'LOADING' : /No messages yet/.test(text) ? 'EMPTY' : text ? `MESSAGES(${log.querySelectorAll('p').length})` : 'BLANK'
      if (state !== last) window.__states.push({ t: Math.round(performance.now() - t0), state })
      last = state
    }
    requestAnimationFrame(tick)
  }
  tick()
}

async function main() {
  await cleanup([])
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await ctx.addInitScript(SAMPLER)
  await ctx.addInitScript(RECORDER)
  const page = await ctx.newPage()
  await page.goto(`${HOST}/`, { waitUntil: 'load' })
  await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
  await page.click('frontdesk-widget button[aria-label="Open chat"]')
  await sleep(800)
  const before = await page.evaluate(() => window.__states.at(-1)?.state)
  console.log(`   state when the visitor starts typing: ${before}`)
  await page.evaluate(() => { window.__states.length = 0 })
  await page.fill('frontdesk-widget input[placeholder="Type a message…"]', 'First message from a new visitor')
  await page.keyboard.press('Enter')
  await page.waitForSelector('frontdesk-widget >> text=First message from a new visitor', { timeout: 15000 })
  await sleep(3000)

  const states = await page.evaluate(() => window.__states)
  console.log('   transcript states after Send, in order:', states.map((s) => `${s.state}@${s.t}ms`).join(' → ') || '(none)')
  check('the transcript never shows "Loading conversation…"', !states.some((s) => s.state === 'LOADING'), states)
  check('and never falls back to "No messages yet" after Send', !states.some((s) => s.state === 'EMPTY'), states)
  check('the visitor\'s message is on screen', states.some((s) => s.state === 'MESSAGES(1)'), states)
  const spoken = (await heard(page)).map((a) => a.text)
  console.log('   live region said:', JSON.stringify(spoken))
  check('nothing about "Loading" is announced', !spoken.some((t) => /Loading/i.test(t)), spoken)
  check('exactly one bubble at the end (no duplicate from an optimistic copy + the echo)', (await page.evaluate(() => document.querySelector('frontdesk-widget').shadowRoot.querySelectorAll('[role="log"] p').length)) === 1)

  const v = (await admin.from('conversations').select('id').eq('customer_name', 'Demo Visitor')).data ?? []
  check('exactly one conversation was created', v.length === 1, v.length)
  const msgs = v[0] ? (await admin.from('messages').select('id').eq('conversation_id', v[0].id)).data : []
  check('and exactly one message stored', msgs.length === 1, msgs.length)
  await browser.close()
}
try { await main() } finally { await cleanup([]) }
process.exit(summary() ? 1 : 0)
