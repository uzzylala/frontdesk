import { chromium } from 'playwright'
import { admin, agents, cleanup, openConsole, check, summary, sleep, until } from '../lib.mjs'
const ids = []
const seed = async (name, n, extra) => {
  const { data } = await admin.from('conversations').insert({ customer_name: name, ...extra }).select().single()
  ids.push(data.id)
  const base = Date.now() - n * 1000
  await admin.from('messages').insert(Array.from({ length: n }, (_, i) => ({ conversation_id: data.id, sender_type: 'customer', body: `${name} #${i} long enough to wrap around in a narrow log so it overflows`, created_at: new Date(base + i * 1000).toISOString() })))
  return data.id
}
async function main() {
  await cleanup([])
  const id = await agents()
  const A = await seed('A11y Restore A', 40, { assigned_agent_id: id['Agent'] })
  const B = await seed('A11y Restore B', 40, { assigned_agent_id: id['Agent'] })
  const browser = await chromium.launch()
  const con = await openConsole(browser, 'Agent')
  await until(async () => (await con.page.$$('[data-conversation-id]')).length >= 7, 15000)
  await con.page.click(`[data-conversation-id="${A}"]`); await sleep(1000)
  const logA = con.page.locator('[role="log"][aria-label="Conversation with A11y Restore A"]')
  await logA.evaluate((el) => { el.scrollTop = 600 }); await sleep(300)
  console.log('   A scrollTop before leaving:', await logA.evaluate((el) => Math.round(el.scrollTop)))
  await con.page.click(`[data-conversation-id="${B}"]`); await sleep(600)
  await admin.from('messages').insert({ conversation_id: A, sender_type: 'customer', body: 'arrives while A hidden and reader mid-history' }); await sleep(1500)
  await con.page.click(`[data-conversation-id="${A}"]`); await sleep(800)
  const t = await logA.evaluate((el) => Math.round(el.scrollTop))
  check('coming back, a reader who was mid-history is where they left off (not yanked to the bottom, not reset to the top)', Math.abs(t - 600) <= 4, `scrollTop ${t}, expected 600`)
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
