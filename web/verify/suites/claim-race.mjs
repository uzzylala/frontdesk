// Manual-claim race: only one agent may win a queued conversation; the loser must be told clearly.
import { chromium } from 'playwright'
import { admin, anonClient as anon, API, agents, cleanup, openChaosConsole, heard, resetHeard, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const queued = async (name) => {
  let data = null
  for (let attempt = 0; attempt < 4 && !data; attempt++) { try { data = (await admin.from('conversations').insert({ customer_name: name }).select().single()).data } catch { await sleep(500) } } // transient network blips must not end a 10-minute run
  if (!data) throw new Error('could not create a queued conversation')
  ids.push(data.id)
  await admin.from('messages').insert({ conversation_id: data.id, sender_type: 'customer', body: 'help' })
  return data.id
}
// Which conversation-claim PATCHes did this page actually send? (Separates "my click lost the race" from "the row
// was already gone before my click landed, so no claim was ever attempted".)
const trackAttempts = (page) => { const set = new Set(); page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/conversations')) { const m = r.url().match(/id=eq.([0-9a-f-]{36})/); if (m) set.add(m[1]) } }); return set }
const owner = async (cid) => (await admin.from('conversations').select('assigned_agent_id').eq('id', cid).single()).data.assigned_agent_id

async function layer1(id) {
  console.log('\n=== 1. Database: concurrent anon claims on ONE queued conversation ===')
  const ROUNDS = 40, CONCURRENT = 10
  const who = [id['Agent'], id['Jordan P.'], id['Sam K.']]
  let notOne = 0, mismatch = 0, totalWins = 0
  for (let r = 0; r < ROUNDS; r++) {
    const cid = await queued(`A11y Race DB ${r}`)
    const clients = Array.from({ length: CONCURRENT }, anon)
    const results = await Promise.all(clients.map((c, i) => c.from('conversations').update({ assigned_agent_id: who[i % 3] }).eq('id', cid).is('assigned_agent_id', null).select()))
    const winners = results.map((res, i) => ({ rows: res.data?.length ?? 0, err: res.error, agent: who[i % 3] })).filter((w) => w.rows > 0)
    totalWins += winners.length
    if (winners.length !== 1) notOne++
    if (winners.length >= 1 && (await owner(cid)) !== winners[0].agent) mismatch++
    if (results.some((x) => x.error)) console.log('   unexpected error:', results.find((x) => x.error).error.message)
  }
  console.log(`   ${ROUNDS} rounds × ${CONCURRENT} simultaneous claimants = ${ROUNDS * CONCURRENT} claim attempts, ${totalWins} succeeded`)
  check(`exactly one winner in every one of ${ROUNDS} rounds`, notOne === 0, `${notOne} rounds had ≠ 1 winner`)
  check('the stored owner is always the one claimant that was told it won', mismatch === 0, `${mismatch} mismatches`)
}

async function layer2(browser, id) {
  console.log('\n=== 2. Two real consoles click "Pick up" at the same instant ===')
  const a = await openChaosConsole(browser, 'Agent')
  const b = await openChaosConsole(browser, 'Jordan P.')
  const attA = trackAttempts(a.page), attB = trackAttempts(b.page)
  const ROUNDS = 14
  let oneOwner = 0, loserTold = 0, loserSawVisible = 0, loserSawSpoken = 0, loserFocusOk = 0, lostAttempts = 0, vanishedFirst = 0, strandedAfterVanish = 0
  const detail = []
  for (let r = 0; r < ROUNDS; r++) {
    const name = `A11y Race UI ${r}`
    const cid = await queued(name)
    const btn = (p) => p.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn(a.page).count()) === 1 && (await btn(b.page).count()) === 1, 15000)
    await Promise.all([resetHeard(a.page), resetHeard(b.page)])
    // Fire both clicks in the same tick. (No auto-scroll/wait between them.)
    await Promise.all([btn(a.page).click({ noWaitAfter: true, timeout: 3000 }).catch(() => {}), btn(b.page).click({ noWaitAfter: true, timeout: 3000 }).catch(() => {})])
    await until(async () => !!(await owner(cid)), 10000)
    await sleep(2500)
    const ownerId = await owner(cid)
    const inA = (await a.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const inB = (await b.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const qA = (await a.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const qB = (await b.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const consistent = (inA !== inB) && !qA && !qB && ((ownerId === id['Agent'] && inA) || (ownerId === id['Jordan P.'] && inB))
    if (consistent) oneOwner++
    const [winner, loser, loserName] = ownerId === id['Agent'] ? [a, b, 'Jordan'] : [b, a, 'Agent']
    const spoken = (await heard(loser.page)).map((x) => x.text)
    const visible = await loser.page.evaluate((n) => document.body.innerText.includes(n + ' was already picked up by another agent.'), name)
    const loserAttempted = (loser === a ? attA : attB).has(cid)
    const focus = await loser.page.evaluate(() => { const a = document.activeElement; return { onBody: !a || a === document.body, text: (a?.textContent ?? '').trim().slice(0, 80) } })
    const told = new RegExp(`${name} was already picked up`).test(focus.text) || spoken.some((t) => new RegExp(`${name}.*already picked up`, 'i').test(t))
    if (loserAttempted) {
      lostAttempts++
      if (told) loserSawSpoken++
      if (visible) loserSawVisible++
      if (!focus.onBody && focus.text.includes('already picked up')) loserFocusOk++
      if (told || visible) loserTold++
    } else {
      vanishedFirst++
      if (focus.onBody) strandedAfterVanish++
    }
    detail.push(`round ${r}: owner=${ownerId === id['Agent'] ? 'Agent' : 'Jordan'}  consistent=${consistent}  loser(${loserName}) attemptedClaim=${loserAttempted} visibleNote=${visible} focus=${focus.onBody ? 'BODY (stranded)' : JSON.stringify(focus.text)}`)
    void winner
  }
  console.log(detail.map((d) => '   ' + d).join('\n'))
  check(`each of ${ROUNDS} rounds ends with exactly one owner; both consoles agree; queue empty on both`, oneOwner === ROUNDS, `${oneOwner}/${ROUNDS}`)
  console.log(`   of ${ROUNDS} rounds: the loser's claim actually ran and lost in ${lostAttempts}; the row vanished before their click landed (no claim attempted) in ${vanishedFirst}`)
  check('the race was really contested: at least some rounds had a claim that ran and lost', lostAttempts >= 3, `${lostAttempts}`)
  check(`when a claim ran and lost, the loser SEES "<name> was already picked up by another agent"`, loserSawVisible === lostAttempts, `${loserSawVisible}/${lostAttempts}`)
  check('and focus is on that message, not stranded on <body> (so a screen reader reads it)', loserFocusOk === lostAttempts, `${loserFocusOk}/${lostAttempts}`)
  check('when the row vanished before the click, focus is not stranded on <body> either', strandedAfterVanish === 0, `${strandedAfterVanish}/${vanishedFirst} stranded`)
  await a.ctx.close(); await b.ctx.close()
}

async function layer3(browser, id) {
  console.log('\n=== 3. Manual claim vs. the server-side queue pull, fired at the same instant ===')
  // The Database Webhook takes 1-2s to arrive, so a status flip alone never ties with a click. Call the very same
  // endpoint the webhook calls (POST /api/agent-online) at the moment of the click, so both CAS writes race for real.
  const agent = await openChaosConsole(browser, 'Agent')
  const jordan = await openChaosConsole(browser, 'Jordan P.')
  const ROUNDS = 21
  let consistent = 0, manualWins = 0, serverWins = 0
  const byDelay = {}
  for (let r = 0; r < ROUNDS; r++) {
    await admin.from('agents').update({ status: 'away' }).eq('id', id['Jordan P.'])
    await sleep(1500)
    const cid = await queued(`A11y Race Pull ${r}`)
    const btn = agent.page.locator(`[data-queue-item-id="${cid}"] button`)
    await until(async () => (await btn.count()) === 1, 15000)
    // Sweep the click's delay after the server chain starts (0-600ms) so the two paths cross over.
    const delay = (r % 7) * 100
    await Promise.all([
      (async () => { await sleep(delay); await btn.click({ noWaitAfter: true, timeout: 3000 }).catch(() => {}) })(),
      (async () => {
        await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
        await fetch(`${API}/api/agent-online`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id['Jordan P.'] }) })
      })(),
    ])
    await until(async () => !!(await owner(cid)), 15000)
    await sleep(2500)
    const ownerId = await owner(cid)
    const inA = (await agent.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const inJ = (await jordan.page.locator(`[data-conversation-id="${cid}"]`).count()) === 1
    const qA = (await agent.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const qJ = (await jordan.page.locator(`[data-queue-item-id="${cid}"]`).count()) === 1
    const good = (inA !== inJ) && !qA && !qJ && ((ownerId === id['Agent'] && inA) || (ownerId === id['Jordan P.'] && inJ))
    if (good) consistent++
    if (ownerId === id['Agent']) manualWins++; else if (ownerId === id['Jordan P.']) serverWins++
    ;(byDelay[delay] ??= []).push(ownerId === id['Agent'] ? 'M' : 'S')
  }
  console.log(`   ${ROUNDS} rounds: manual claim won ${manualWins}, server pull won ${serverWins}`)
  console.log('   winner by click delay after the server chain started (M = manual click, S = server pull):', Object.entries(byDelay).map(([d, w]) => `${d}ms:${w.join('')}`).join('  '))
  check(`every round: exactly one owner, both consoles agree, no ghost queue entry (${ROUNDS} rounds)`, consistent === ROUNDS, `${consistent}/${ROUNDS}`)
  check('the race was genuinely contested: BOTH paths won at least once (otherwise this proved nothing)', manualWins > 0 && serverWins > 0, `manual ${manualWins} / server ${serverWins}`)
  await agent.ctx.close(); await jordan.ctx.close()
}

async function main() {
  await cleanup([])
  const id = await agents()
  await layer1(id)
  const browser = await chromium.launch()
  await layer2(browser, id)
  await layer3(browser, id)
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
