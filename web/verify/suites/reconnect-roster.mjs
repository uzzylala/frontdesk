// Fix 1: the agent roster (other agents' status chips) must resync after the Realtime link drops and returns.
// Realtime doesn't replay what it missed; before the fix the chips stay stale until a page reload.
import { chromium } from 'playwright'
import { admin, agents, cleanup, openChaosConsole, openConsole, chipState, heard, check, summary, sleep, until } from '../lib.mjs'

async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  // Jordan has a live console, so presence says "connected" and the chip shows their real status (away).
  await openConsole(browser, 'Jordan P.')
  const me = await openChaosConsole(browser, 'Agent')
  await until(async () => (await chipState(me.page, id['Jordan P.'])) === 'away', 10000)
  check('before the outage: my roster shows Jordan as away', (await chipState(me.page, id['Jordan P.'])) === 'away', await chipState(me.page, id['Jordan P.']))

  console.log('\n-- severing MY realtime socket (HTTP still works) --')
  await me.chaos.drop()
  await until(async () => await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
  check('the console notices: "Connection lost" banner is up', await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible())

  // While I'm cut off: Jordan goes busy, then Sam (never opened) is set busy too. I can't hear either.
  await admin.from('agents').update({ status: 'busy' }).eq('id', id['Jordan P.'])
  await sleep(1500)
  check('while cut off, my chip for Jordan is still the old value (I really missed it)', (await chipState(me.page, id['Jordan P.'])) === 'away', await chipState(me.page, id['Jordan P.']))

  console.log('\n-- restoring the socket --')
  const t0 = Date.now()
  me.chaos.restore()
  const banner = await until(async () => !(await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible()), 30000)
  console.log(`   banner cleared after ${(Date.now() - t0) / 1000}s (supabase-js backoff)`)
  check('the link comes back (banner gone)', banner.ok)
  const caught = await until(async () => (await chipState(me.page, id['Jordan P.'])) === 'busy', 12000)
  check('AFTER reconnect my roster catches up: Jordan shows busy', caught.ok, `chip is "${await chipState(me.page, id['Jordan P.'])}" 12s after the link returned`)

  const spoke = await until(async () => (await heard(me.page)).some((a) => /Jordan P. is now Busy/.test(a.text)), 8000)
  check('and the caught-up change is spoken via the live region', spoke.ok, await heard(me.page))
  console.log('   heard:', JSON.stringify((await heard(me.page)).map((a) => a.text)))
  await browser.close()
}
try { await main() } finally { await cleanup([]) }
process.exit(summary() ? 1 : 0)
