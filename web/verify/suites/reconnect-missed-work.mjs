// Fix 2: work that lands while the socket is down (new assignments, new customer messages) must not just
// appear silently on reconnect — it has to be spoken through the live region, and must not be spoken twice.
import { chromium } from 'playwright'
import { admin, agents, makeConv, cleanup, openChaosConsole, heard, resetHeard, sidebarIds, check, summary, sleep, until } from '../lib.mjs'

const ids = []
async function main() {
  await cleanup([])
  const id = await agents()
  const existing = await makeConv({ customer_name: 'A11y Existing', assigned_agent_id: id['Agent'] }, [{ body: 'hello' }])
  const other = await makeConv({ customer_name: 'A11y Other', assigned_agent_id: id['Agent'] }, [{ body: 'hi' }])
  ids.push(existing, other)
  const browser = await chromium.launch()
  const me = await openChaosConsole(browser, 'Agent')
  await until(async () => (await sidebarIds(me.page)).includes(existing) && (await sidebarIds(me.page)).includes(other), 15000)
  // Look at a different conversation, so `existing` is a background one that can accrue unread.
  await me.page.click(`[data-conversation-id="${other}"]`)
  await sleep(2500)
  check('setup: opening the console announced nothing', (await heard(me.page)).length === 0, await heard(me.page))

  console.log('\n-- severing the realtime socket --')
  await me.chaos.drop()
  await until(async () => await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)

  // While cut off: two conversations get assigned to me, and a customer writes in an existing one.
  const m1 = await makeConv({ customer_name: 'A11y Missed One', assigned_agent_id: id['Agent'], previous_agent_id: id['Sam K.'] }, [{ body: 'are you there' }])
  const m2 = await makeConv({ customer_name: 'A11y Missed Two', assigned_agent_id: id['Agent'] }, [{ body: 'help' }])
  ids.push(m1, m2)
  await admin.from('messages').insert({ conversation_id: existing, sender_type: 'customer', body: 'missed message 1' })
  await admin.from('messages').insert({ conversation_id: existing, sender_type: 'customer', body: 'missed message 2' })
  await sleep(1500)
  check('while cut off, none of it is on my screen', !(await sidebarIds(me.page)).includes(m1) && !(await sidebarIds(me.page)).includes(m2))

  console.log('\n-- restoring the socket --')
  await resetHeard(me.page)
  const t0 = Date.now()
  me.chaos.restore()
  const shown = await until(async () => { const s = await sidebarIds(me.page); return s.includes(m1) && s.includes(m2) }, 30000)
  check('both missed conversations appear in the list after reconnect', shown.ok)
  console.log(`   (visible ${(Date.now() - t0) / 1000}s after restore)`)
  await sleep(5000) // > batch quiet window, so anything that is going to be spoken has been
  const spoken = await heard(me.page)
  console.log('   heard:', JSON.stringify(spoken.map((a) => a.text)))
  check('a missed assignment is SPOKEN: one batched announcement naming both', spoken.some((a) => /2 conversations assigned to you/.test(a.text) && /A11y Missed One/.test(a.text) && /A11y Missed Two/.test(a.text)), spoken)
  check('it is spoken once, not repeated', spoken.filter((a) => /assigned to you/.test(a.text)).length === 1, spoken)

  const badge = await me.page.locator(`[data-conversation-id="${existing}"]`).getAttribute('aria-label')
  console.log(`   existing conversation's accessible name after reconnect: "${badge}"`)
  check('missed customer messages in an existing conversation show as unread', /2 unread/.test(badge ?? ''), badge)
  check('and are spoken ("2 new messages from A11y Existing")', spoken.some((a) => /A11y Existing/.test(a.text) && /2 new messages|New message/.test(a.text)), spoken)

  // Regression guard: the *initial* load must still say nothing, and ordinary live assignment still says its one thing.
  console.log('\n-- second reconnect with nothing missed must be silent --')
  await me.chaos.drop()
  await until(async () => await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
  await resetHeard(me.page)
  me.chaos.restore()
  await until(async () => !(await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible()), 30000)
  await sleep(5000)
  check('reconnect with nothing missed announces nothing', (await heard(me.page)).length === 0, await heard(me.page))
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
