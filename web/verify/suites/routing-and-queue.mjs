import { chromium } from 'playwright'
import { admin, APP as APP_URL, cleanup } from '../lib.mjs'

let passCount = 0
let failCount = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`)
    passCount++
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failCount++
  }
}

async function setAgentStatus(name, status) {
  const { data: agent } = await admin.from('agents').select('*').eq('name', name).single()
  await admin.from('agents').update({ status }).eq('id', agent.id)
  return agent
}

async function pickAgent(page, name) {
  await page.goto(`${APP_URL}/agent`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1:has-text("Who are you?")', { timeout: 10000 })
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`, { timeout: 10000 })
}

async function sidebarConversationIds(page) {
  return page.$$eval('[data-conversation-id]', (els) => els.map((el) => el.getAttribute('data-conversation-id')))
}

async function queueItemIds(page) {
  return page.$$eval('[data-queue-item-id]', (els) => els.map((el) => el.getAttribute('data-queue-item-id')))
}

async function createCustomerConversation(browser) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${APP_URL}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('input[placeholder="Type a message…"]', { timeout: 10000 })
  const conversationId = await page.evaluate(() =>
    localStorage.getItem('frontdesk:customer-conversation-id'),
  )
  await ctx.close()
  return conversationId
}

async function main() {
  await cleanup()
  console.log('--- Setup: all agents away ---')
  await setAgentStatus('Agent', 'away')
  await setAgentStatus('Jordan P.', 'away')
  await setAgentStatus('Sam K.', 'away')

  const browser = await chromium.launch()

  console.log('\n--- Opening 3 agent console sessions (separate browser contexts) ---')
  const ctxAgent = await browser.newContext()
  const ctxJordan = await browser.newContext()
  const ctxSam = await browser.newContext()
  const pageAgent = await ctxAgent.newPage()
  const pageJordan = await ctxJordan.newPage()
  const pageSam = await ctxSam.newPage()

  await pickAgent(pageAgent, 'Agent')
  await pickAgent(pageJordan, 'Jordan P.')
  await pickAgent(pageSam, 'Sam K.')

  console.log('\n[Test d — baseline scoping]')
  await pageAgent.waitForTimeout(1000)
  const agentIds = await sidebarConversationIds(pageAgent)
  check('Agent sees exactly 5 assigned conversations', agentIds.length === 5, `got ${agentIds.length}`)

  const jordanEmpty = await pageJordan.locator('text=No conversations assigned to you yet').isVisible()
  const samEmpty = await pageSam.locator('text=No conversations assigned to you yet').isVisible()
  check('Jordan P. sees none of Agent\'s conversations', jordanEmpty)
  check('Sam K. sees none of Agent\'s conversations', samEmpty)

  console.log('\n[Test b — no agents online → new conversations queue]')
  const countBefore = (await admin.from('conversations').select('id', { count: 'exact', head: true })).count
  const queued1 = await createCustomerConversation(browser)
  await new Promise((r) => setTimeout(r, 1500))
  const conv1 = await admin.from('conversations').select('*').eq('id', queued1).single()
  check('conversation 1 assigned_agent_id is null (queued)', conv1.data.assigned_agent_id === null)

  const countAfterOne = (await admin.from('conversations').select('id', { count: 'exact', head: true })).count
  check('one customer page load creates exactly ONE conversation (no StrictMode orphan)', countAfterOne === countBefore + 1, 'before=' + countBefore + ' after=' + countAfterOne)

  const queued2 = await createCustomerConversation(browser)
  await new Promise((r) => setTimeout(r, 1500))
  const conv2 = await admin.from('conversations').select('*').eq('id', queued2).single()
  check('conversation 2 assigned_agent_id is null (queued)', conv2.data.assigned_agent_id === null)

  // Queue is visible to any agent console — check via Agent's view.
  await pageAgent.waitForTimeout(1000)
  const queueSeenByAgent = await queueItemIds(pageAgent)
  check(
    'both queued conversations visible in queue view',
    queueSeenByAgent.includes(queued1) && queueSeenByAgent.includes(queued2),
    JSON.stringify(queueSeenByAgent),
  )

  console.log('\n[Test c — bringing an agent online pulls the OLDEST queued conversation]')
  const t0 = Date.now()
  await pageSam.click('label:has-text("online")')
  let samIdsAfterOnline = []
  while (Date.now() - t0 < 10000) {
    samIdsAfterOnline = await sidebarConversationIds(pageSam)
    if (samIdsAfterOnline.length > 0) break
    await pageSam.waitForTimeout(200)
  }
  console.log('  (pull latency ms:', Date.now() - t0, ')')
  check(
    'Sam K. auto-received the OLDER queued conversation (queued1)',
    samIdsAfterOnline.includes(queued1) && !samIdsAfterOnline.includes(queued2),
    JSON.stringify(samIdsAfterOnline),
  )

  console.log('\n[Test a — new conversation routes to the (only) online agent]')
  const queued3 = await createCustomerConversation(browser)
  await new Promise((r) => setTimeout(r, 1500))
  const conv3 = await admin.from('conversations').select('*').eq('id', queued3).single()
  const samAgentRow = await admin.from('agents').select('id').eq('name', 'Sam K.').single()
  check(
    'conversation 3 auto-routed to Sam K. (only online agent)',
    conv3.data.assigned_agent_id === samAgentRow.data.id,
    `assigned_agent_id=${conv3.data.assigned_agent_id}`,
  )
  await pageSam.waitForTimeout(1500)
  const samIdsAfterNew = await sidebarConversationIds(pageSam)
  check('conversation 3 shows live in Sam K.\'s sidebar', samIdsAfterNew.includes(queued3))

  console.log('\n[Test — manual queue pickup fallback, by a non-online agent]')
  await pageJordan.waitForTimeout(1000)
  const jordanQueueBefore = await queueItemIds(pageJordan)
  check('queued2 still visible in queue for Jordan (still away)', jordanQueueBefore.includes(queued2))
  await pageJordan.click(`[data-queue-item-id="${queued2}"] button:has-text("Pick up")`)
  await pageJordan.waitForTimeout(1500)
  const jordanIdsAfterPickup = await sidebarConversationIds(pageJordan)
  check(
    'Jordan P. (still away) manually picked up queued2',
    jordanIdsAfterPickup.includes(queued2),
    JSON.stringify(jordanIdsAfterPickup),
  )

  console.log('\n[Test d — final scoping check: no leakage across agents]')
  const finalAgentIds = await sidebarConversationIds(pageAgent)
  const finalSamIds = await sidebarConversationIds(pageSam)
  const finalJordanIds = await sidebarConversationIds(pageJordan)

  check('Agent\'s list unaffected by other agents\' activity (still 5)', finalAgentIds.length === 5)
  check('Sam\'s list has no overlap with Jordan\'s', finalSamIds.every((id) => !finalJordanIds.includes(id)))
  check('Sam\'s list has no overlap with Agent\'s', finalSamIds.every((id) => !finalAgentIds.includes(id)))
  check('Jordan\'s list has no overlap with Agent\'s', finalJordanIds.every((id) => !finalAgentIds.includes(id)))
  check('Sam sees exactly 2 (queued1 auto-pull + queued3 routed)', finalSamIds.length === 2, JSON.stringify(finalSamIds))
  check('Jordan sees exactly 1 (queued2 manual pickup)', finalJordanIds.length === 1, JSON.stringify(finalJordanIds))

  await browser.close()

  await cleanup()
  console.log(`\n${passCount} passed, ${failCount} failed`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('FAILED', err)
  await cleanup()
  process.exit(1)
})
