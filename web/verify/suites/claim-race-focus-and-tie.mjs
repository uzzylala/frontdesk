// (A) Keyboard user is FOCUSED on a "Pick up" button when someone else takes that conversation: where does focus go?
// (B) A true tie between a manual claim and the server-side queue pull: sweep the click's timing across the server's latency.
import { chromium } from 'playwright'
import { API, admin, agents, cleanup, openChaosConsole, heard, resetHeard, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const queued = async (name) => {
  let data = null
  for (let i = 0; i < 4 && !data; i++) { try { data = (await admin.from('conversations').insert({ customer_name: name }).select().single()).data } catch { await sleep(500) } }
  ids.push(data.id)
  await admin.from('messages').insert({ conversation_id: data.id, sender_type: 'customer', body: 'help' })
  return data.id
}
const owner = async (cid) => (await admin.from('conversations').select('assigned_agent_id').eq('id', cid).single()).data.assigned_agent_id
const activeDesc = (page) => page.evaluate(() => { const a = document.activeElement; return { onBody: !a || a === document.body, text: (a?.textContent ?? '').trim().slice(0, 90), tag: a?.tagName } })

async function partA(browser) {
  console.log('\n=== A. Focused on "Pick up" when another agent takes the conversation ===')
  const me = await openChaosConsole(browser, 'Agent')
  const name = 'A11y Focus Victim'
  const cid = await queued(name)
  const btn = me.page.locator(`[data-queue-item-id="${cid}"] button`)
  await until(async () => (await btn.count()) === 1, 15000)
  await btn.focus()
  check('setup: keyboard focus is on the Pick up button', (await me.page.evaluate(() => document.activeElement?.textContent)).includes('Pick up'))
  await resetHeard(me.page)
  await admin.from('conversations').update({ assigned_agent_id: (await agents())['Jordan P.'] }).eq('id', cid) // someone else takes it
  await until(async () => (await btn.count()) === 0, 8000)
  await sleep(1800)
  const f = await activeDesc(me.page)
  const spoken = (await heard(me.page)).map((x) => x.text)
  console.log('   focus after the row vanished:', f.onBody ? 'BODY (stranded)' : JSON.stringify(f), '| spoken:', JSON.stringify(spoken))
  check('focus is not stranded on <body> after the focused row disappears', !f.onBody, f)
  await me.ctx.close()
}

async function partB(browser, id) {
  console.log('\n=== B. Manual claim vs server pull: sweep the click delay across the server latency ===')
  const agent = await openChaosConsole(browser, 'Agent')
  const jordan = await openChaosConsole(browser, 'Jordan P.')
  // The server chain takes ~0.8-1.8s end to end and varies with the network, so the click delay must sweep the whole
  // range (from 0) for both paths to have a chance of winning; a narrower window can miss the crossover entirely.
  const delays = [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]
  const ROUNDS = delays.length * 2
  let consistent = 0, manual = 0, server = 0
  const byDelay = {}
  const serverMs = []
  for (let r = 0; r < ROUNDS; r++) {
    const delay = delays[r % delays.length]
    await admin.from('agents').update({ status: 'away' }).eq('id', id['Jordan P.'])
    await sleep(1500)
    const cid = await queued(`A11y Tie ${r}`)
    const btn = agent.page.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn.count()) === 1, 15000)
    const t0 = Date.now()
    let serverDone = 0
    await Promise.all([
      (async () => { await sleep(delay); await btn.click({ noWaitAfter: true, timeout: 3000 }).catch(() => {}) })(),
      (async () => {
        await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
        await fetch(`${API}/api/agent-online`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id['Jordan P.'] }) })
        serverDone = Date.now() - t0
      })(),
    ])
    serverMs.push(serverDone)
    await until(async () => !!(await owner(cid)), 15000)
    await sleep(2500)
    const ownerId = await owner(cid)
    const inA = (await agent.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const inJ = (await jordan.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const qA = (await agent.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const qJ = (await jordan.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const good = (inA !== inJ) && !qA && !qJ && ((ownerId === id['Agent'] && inA) || (ownerId === id['Jordan P.'] && inJ))
    if (good) consistent++
    else console.log(`   round ${r} (click delay ${delay}ms) INCONSISTENT: owner=${ownerId === id['Agent'] ? 'Agent' : ownerId === id['Jordan P.'] ? 'Jordan' : ownerId}  inAgentList=${inA} inJordanList=${inJ}  stillQueuedForAgent=${qA} stillQueuedForJordan=${qJ}`)
    if (ownerId === id['Agent']) manual++; else if (ownerId === id['Jordan P.']) server++
    ;(byDelay[delay] ??= []).push(ownerId === id['Agent'] ? 'M' : 'S')
  }
  console.log(`   server chain (status flip + API call) took ${Math.min(...serverMs)}-${Math.max(...serverMs)}ms end to end`)
  console.log(`   ${ROUNDS} rounds: manual won ${manual}, server won ${server}`)
  console.log('   winner by click delay (M=manual, S=server pull):', Object.entries(byDelay).map(([d, w]) => `${d}ms:${w.join('')}`).join('  '))
  check(`every round: exactly one owner, both consoles agree, no ghost queue entry (${ROUNDS} rounds)`, consistent === ROUNDS, `${consistent}/${ROUNDS}`)
  check('genuinely contested: both paths won at least once', manual > 0 && server > 0, `manual ${manual} / server ${server}`)
  await agent.ctx.close(); await jordan.ctx.close()
}

async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  if (!process.env.PART || process.env.PART === "A") await partA(browser)
  if (!process.env.PART || process.env.PART === "B") await partB(browser, id)
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
