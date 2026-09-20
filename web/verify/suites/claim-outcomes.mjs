// The three outcomes of clicking "Pick up": claimed / lost / error — each deterministic, none relying on timing luck.
import { chromium } from 'playwright'
import { admin, agents, cleanup, openChaosConsole, sidebarIds, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const queued = async (name) => {
  const { data } = await admin.from('conversations').insert({ customer_name: name }).select().single()
  ids.push(data.id)
  await admin.from('messages').insert({ conversation_id: data.id, sender_type: 'customer', body: 'help' })
  return data.id
}
const focus = (page) => page.evaluate(() => { const a = document.activeElement; return { onBody: !a || a === document.body, tag: a?.tagName, text: (a?.textContent ?? '').trim().slice(0, 90), label: a?.getAttribute('aria-label') ?? '', inMessageBox: !!a?.closest('form[aria-label="Send a message"]') } })
const bodyHas = (page, t) => page.evaluate((x) => document.body.innerText.includes(x), t)

async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  const me = await openChaosConsole(browser, 'Agent')

  console.log('\n=== 1. Server pull gave the conversation to ME an instant before my click ===')
  {
    const name = 'A11y Outcome Mine'
    const cid = await queued(name)
    const btn = me.page.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn.count()) === 1, 15000)
    await me.chaos.drop() // freeze the UI: the row stays, while the truth changes underneath
    await until(async () => await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
    await admin.from('conversations').update({ assigned_agent_id: id['Agent'] }).eq('id', cid)
    await btn.focus(); await me.page.keyboard.press('Enter')
    await sleep(800)
    check('it is NOT reported as "already picked up by another agent"', !(await bodyHas(me.page, 'already picked up by another agent')))
    me.chaos.restore()
    const opened = await until(async () => (await sidebarIds(me.page)).includes(cid), 30000)
    check('the conversation opens in my list', opened.ok)
    const landed = await until(async () => (await focus(me.page)).inMessageBox, 8000)
    check('and focus lands in its message box (a successful claim, exactly like any other)', landed.ok, await focus(me.page))
  }

  console.log('\n=== 2. Someone ELSE got it first ===')
  {
    const name = 'A11y Outcome Lost'
    const cid = await queued(name)
    const btn = me.page.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn.count()) === 1, 15000)
    await me.chaos.drop()
    await until(async () => await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
    await admin.from('conversations').update({ assigned_agent_id: id['Jordan P.'] }).eq('id', cid)
    await btn.focus(); await me.page.keyboard.press('Enter')
    await until(async () => await bodyHas(me.page, 'already picked up by another agent'), 5000)
    await sleep(200)
    const f = await focus(me.page)
    check(`the loser is told: "${name} was already picked up by another agent."`, await bodyHas(me.page, `${name} was already picked up by another agent.`))
    check('focus is on that message', !f.onBody && f.text.includes('already picked up'), f)
    me.chaos.restore()
    await until(async () => !(await me.page.locator('[role="status"]:has-text("Connection lost")').isVisible()), 30000)
    await sleep(1500)
    check('it did not land in my list', !(await sidebarIds(me.page)).includes(cid))
  }

  console.log('\n=== 3. The claim itself FAILS (network error) ===')
  {
    const name = 'A11y Outcome Error'
    const cid = await queued(name)
    const btn = me.page.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn.count()) === 1, 15000)
    await me.page.route('**/rest/v1/conversations?*', (route) => (route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()))
    await btn.focus(); await me.page.keyboard.press('Enter')
    await sleep(1200)
    const f = await focus(me.page)
    check('the agent is told it FAILED — not that someone else got it', await bodyHas(me.page, `Couldn't pick up ${name}.`) && !(await bodyHas(me.page, `${name} was already picked up`)))
    check('focus is on that message', !f.onBody && f.text.includes("Couldn't pick up"), f)
    check('the conversation is still in the queue, still claimable', (await me.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1)
    check('and still unassigned in the database', !(await admin.from('conversations').select('assigned_agent_id').eq('id', cid).single()).data.assigned_agent_id)
    // Retry works once the network is back.
    await me.page.unroute('**/rest/v1/conversations?*')
    await me.page.locator(`[data-queue-item-id="${cid}"] button`).focus(); await me.page.keyboard.press('Enter')
    const retried = await until(async () => (await admin.from('conversations').select('assigned_agent_id').eq('id', cid).single()).data.assigned_agent_id === id['Agent'], 10000)
    check('retrying after the network is back claims it', retried.ok)
  }
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
