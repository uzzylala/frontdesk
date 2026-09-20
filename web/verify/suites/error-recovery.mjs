// Error-recovery audit: inject a REAL failure for each async operation and check what the user experiences.
// For each: is the failure visible and accessible, is anything wrongly lost or mislabelled, and can the user recover?
import { chromium } from 'playwright'
import { admin, agents, watchNewConversations, makeConv, cleanup, HOST, APP, SAMPLER, openChaosConsole, heard, sidebarIds, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const want = (n) => !process.env.ONLY || process.env.ONLY.split(',').includes(String(n))
const text = (page) => page.evaluate(() => document.body.innerText)
const has = async (page, t) => (await text(page)).includes(t)
// postgrest-js retries a failed GET (backoff ~1s+2s+4s), so a read failure only surfaces after ~8-10s.
const settle = (fn, ms = 20000) => until(async () => { try { return await fn() } catch { return false } }, ms, 300)
const fail = (flag, method) => (route) => (flag.on && (!method || route.request().method() === method) ? route.abort('failed') : route.continue())

async function newConsole(browser, name, routes = []) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  await ctx.addInitScript(SAMPLER)
  const page = await ctx.newPage()
  for (const [glob, handler] of routes) await page.route(glob, handler)
  return { ctx, page }
}
async function pick(page, name) {
  await page.goto(`${APP}/agent`, { waitUntil: 'load' })
  await page.waitForSelector('h1:has-text("Who are you?")')
  await page.click(`button:has-text("${name}")`)
  await page.waitForSelector(`h1:has-text("${name}")`)
}

async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()

  // ---------------------------------------------------------------- 1. change status
  console.log('\n=== 1. Changing status fails (network error on the save) ===')
  if (want(1)) {
    const f = { on: false }
    const { ctx, page } = await newConsole(browser, 'Agent', [['**/rest/v1/agents*', fail(f, 'PATCH')]])
    await pick(page, 'Agent')
    await sleep(1500)
    f.on = true
    await page.getByLabel('Online', { exact: true }).check({ force: true }).catch(() => page.locator('input[name="agent-status"][value="online"]').check({ force: true }))
    await sleep(1500)
    const checkedNow = await page.locator('input[name="agent-status"]:checked').getAttribute('value')
    const dbStatus = (await admin.from('agents').select('status').eq('id', id['Agent']).single()).data.status
    check('the control shows the TRUE status again (away), not the one that failed', checkedNow === 'away' && dbStatus === 'away', { checkedNow, dbStatus })
    const told = await page.evaluate(() => !!document.querySelector('[role="alert"]') && /status/i.test(document.querySelector('[role="alert"]')?.textContent ?? ''))
    check('and the agent is told the change did not save (role="alert")', told, (await text(page)).slice(0, 0))
    await ctx.close()
  }

  // ---------------------------------------------------------------- 2. history load fails
  console.log('\n=== 2. A conversation\'s message history fails to load ===')
  if (want(2)) {
    const A = await makeConv({ customer_name: 'A11y History', assigned_agent_id: id['Agent'] }, [{ body: 'first customer message' }, { body: 'second customer message' }])
    ids.push(A)
    const f = { on: true }
    const { ctx, page } = await newConsole(browser, 'Agent', [['**/rest/v1/messages*', fail(f, 'GET')]])
    await pick(page, 'Agent')
    await until(async () => (await sidebarIds(page)).includes(A), 15000)
    await page.click(`[data-conversation-id="${A}"]`)
    await settle(async () => !(await has(page, 'Loading conversation')), 25000)
    await sleep(500)
    console.log('   what the transcript shows:', JSON.stringify((await page.locator('[role="log"]:visible').first().innerText()).slice(0, 80)), '| banner:', JSON.stringify((await page.locator('[role="status"]:visible').allInnerTexts()).join(' / ').slice(0, 100)))
    const wronglyEmpty = await has(page, 'No messages yet')
    check('a failed load is NOT presented as an empty conversation ("No messages yet — say hello.")', !wronglyEmpty)
    check('the conversation-list item does not say "no messages yet" either (name says the load failed)', ((await page.locator(`[data-conversation-id="${A}"]`).getAttribute('aria-label')) ?? '').includes("couldn't load messages"))
    const err = await page.evaluate(() => /couldn't load (the |this conversation's )?messages|couldn't load this conversation/i.test(document.body.innerText))
    check('it says the messages could not be loaded', err)
    const retry = page.getByRole('button', { name: /try again|retry/i })
    check('and offers a retry', (await retry.count()) > 0)
    f.on = false
    if ((await retry.count()) > 0) { await retry.first().click() }
    check('retrying loads the conversation', (await settle(async () => await has(page, 'first customer message'), 15000)).ok)
    await ctx.close()
  }

  if (want(2)) {
    console.log('\n=== 2b. History loaded fine, then the BACK-FILL after an outage fails ===')
    const A = await makeConv({ customer_name: 'A11y Backfill', assigned_agent_id: id['Agent'] }, [{ body: 'message I already have' }])
    const B = await makeConv({ customer_name: 'A11y Other', assigned_agent_id: id['Agent'] }, [{ body: 'x' }])
    ids.push(A, B)
    const f = { on: false }
    const con = await openChaosConsole(browser, 'Agent')
    await con.page.route('**/rest/v1/messages*', fail(f, 'GET'))
    await until(async () => (await sidebarIds(con.page)).includes(A), 15000)
    await con.page.click(`[data-conversation-id="${B}"]`) // A is a background conversation
    await sleep(1500)
    f.on = true
    await con.chaos.drop()
    await until(async () => await con.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
    await admin.from('messages').insert({ conversation_id: A, sender_type: 'customer', body: 'sent while I was offline' })
    con.chaos.restore()
    await con.page.click(`[data-conversation-id="${A}"]`)
    await settle(async () => await has(con.page, 'Some recent messages may be missing'), 40000)
    check('the transcript I already had stays on screen', await has(con.page, 'message I already have'))
    check('and a notice says some recent messages may be missing (not a silent gap)', await has(con.page, 'Some recent messages may be missing'))
    check('with a Refresh button', (await con.page.getByRole('button', { name: 'Refresh' }).count()) > 0)
    f.on = false
    await con.page.getByRole('button', { name: 'Refresh' }).click()
    check('Refresh brings in the message that was missed', (await settle(async () => await has(con.page, 'sent while I was offline'), 15000)).ok)
    check('and the notice goes away', !(await has(con.page, 'Some recent messages may be missing')))
    await con.ctx.close()
  }

  // ---------------------------------------------------------------- 3. resync after reconnect fails
  console.log('\n=== 3. The reconnect re-sync itself fails (network flaps again) ===')
  if (want(3)) {
    const f = { on: false }
    const con = await openChaosConsole(browser, 'Agent')
    await con.page.route('**/rest/v1/conversations*', fail(f, 'GET'))
    await until(async () => (await sidebarIds(con.page)).length >= 5, 15000)
    const before = (await sidebarIds(con.page)).length
    f.on = true
    await con.chaos.drop()
    const missed = await makeConv({ customer_name: 'A11y Missed In Outage', assigned_agent_id: id['Agent'] }, [{ body: 'hi' }]); ids.push(missed)
    await until(async () => await con.page.locator('[role="status"]:has-text("Connection lost")').isVisible(), 20000)
    con.chaos.restore()
    await sleep(16000) // the re-sync's own retries take ~8s to give up
    const stillThere = (await sidebarIds(con.page)).length
    check(`my ${before} conversations stay on screen while the re-sync is failing`, stillThere === before, `${stillThere}/${before} visible; page says: ${(await text(con.page)).includes("Couldn't load conversations") ? '"Couldn\'t load conversations"' : '?'}`)
    check('a quiet notice says the list may be out of date (not a blocking error)', (await has(con.page, "Couldn't refresh your conversations")) && (await con.page.locator('[role="alert"]').count()) === 0)
    f.on = false
    await sleep(20000)
    check('a conversation assigned to me DURING the failed re-sync appears once it succeeds', (await sidebarIds(con.page)).includes(missed))
    check('and is announced (the reconnect context survives the retries)', (await heard(con.page)).some((x) => /A11y Missed In Outage/.test(x.text) && /assigned to you/.test(x.text)), (await heard(con.page)).map((x) => x.text))
    const recovered = !(await has(con.page, "Couldn't refresh your conversations")) && (await sidebarIds(con.page)).length === before + 1 // the one assigned during the outage joins
    check('and once the network is back it recovers by itself (no reload)', recovered, { visible: (await sidebarIds(con.page)).length })
    await con.ctx.close()
  }

  // ---------------------------------------------------------------- 4. widget: remembered conversation lookup fails
  console.log('\n=== 4. Widget: looking up the visitor\'s remembered conversation fails ===')
  if (want(4)) {
    const W = await makeConv({ customer_name: 'Demo Visitor' }, [{ body: 'my earlier question' }])
    ids.push(W)
    const f = { on: true }
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    // seed once per tab: an init script that re-seeded on every navigation would hide the very bug under test
    await ctx.addInitScript((cid) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('frontdesk:widget:conversation-id', cid); sessionStorage.setItem('seeded', '1') } }, W)
    const page = await ctx.newPage()
    await page.route('**/rest/v1/conversations*', fail(f, 'GET'))
    await page.goto(`${HOST}/`, { waitUntil: 'load' })
    await page.waitForSelector('frontdesk-widget button[aria-label="Open chat"]', { state: 'attached' })
    await sleep(14000) // the lookup retries ~8s before it gives up
    const stored = await page.evaluate(() => localStorage.getItem('frontdesk:widget:conversation-id'))
    check('a network error does NOT erase the visitor\'s saved conversation', stored === W, { stored })
    // The visitor writes while the lookup is failing: it must fail cleanly, not open a SECOND conversation.
    await page.click('frontdesk-widget button[aria-label="Open chat"]')
    await page.fill('frontdesk-widget input[placeholder="Type a message…"]', 'sent during the outage')
    await page.keyboard.press('Enter')
    await settle(async () => await page.evaluate(() => document.querySelector('frontdesk-widget').shadowRoot.textContent.includes('failed to send')), 30000)
    const conv1 = (await admin.from('conversations').select('id').eq('customer_name', 'Demo Visitor')).data.length
    check('sending during the outage fails cleanly (told so) rather than starting a duplicate conversation', (await page.evaluate(() => document.querySelector('frontdesk-widget').shadowRoot.textContent.includes('failed to send'))) && conv1 === 1, { conversations: conv1 })
    check('and the visitor\'s draft is kept', (await page.locator('frontdesk-widget input[placeholder="Type a message…"]').inputValue()) === 'sent during the outage')
    f.on = false
    await page.keyboard.press('Enter')
    const landed = await until(async () => (await admin.from('messages').select('id').eq('conversation_id', W).eq('body', 'sent during the outage')).data?.length === 1, 20000)
    const conv2 = (await admin.from('conversations').select('id').eq('customer_name', 'Demo Visitor')).data.length
    check('once the network is back the message goes into their ORIGINAL conversation, and there is still only one', landed.ok && conv2 === 1, { landed: landed.ok, conversations: conv2 })
    const back = await page.evaluate(() => document.querySelector('frontdesk-widget').shadowRoot.textContent.includes('my earlier question'))
    check('and their earlier message is there', back)
    await ctx.close()
  }

  // ---------------------------------------------------------------- 5. initial loads: is there a way back?
  console.log('\n=== 5. Initial loads fail: is there a way to retry without a page reload? ===')
  if (want(5)) {
    const f = { on: true }
    const { ctx, page } = await newConsole(browser, 'Agent', [['**/rest/v1/agents*', fail(f, 'GET')]])
    await page.goto(`${APP}/agent`, { waitUntil: 'load' })
    await settle(async () => (await page.locator('[role="alert"]').count()) > 0, 20000)
    check('agents list fails → the error is announced (role="alert")', await page.locator('[role="alert"]:has-text("Couldn\'t load agents")').count() > 0)
    const btn = page.getByRole('button', { name: /try again|retry/i })
    check('  …and offers "Try again"', (await btn.count()) > 0)
    f.on = false
    if ((await btn.count()) > 0) { await btn.first().click() }
    check('  …which recovers without a page reload', (await settle(async () => (await page.locator('h1:has-text("Who are you?")').count()) > 0, 15000)).ok)
    await ctx.close()
  }
  if (want(5)) {
    const f = { on: false }
    const { ctx, page } = await newConsole(browser, 'Agent', [['**/rest/v1/conversations*', fail(f, 'GET')]])
    f.on = true
    await pick(page, 'Agent').catch(() => {})
    await settle(async () => (await page.locator('[role="alert"]:has-text("load conversations")').count()) > 0, 25000)
    check('roster fails → announced (role="alert")', await page.locator('[role="alert"]:has-text("Couldn\'t load conversations")').count() > 0)
    const btn = page.getByRole('button', { name: /try again|retry/i })
    check('  …and offers "Try again"', (await btn.count()) > 0)
    f.on = false
    if ((await btn.count()) > 0) { await btn.first().click() }
    check('  …which recovers without a page reload', (await settle(async () => (await sidebarIds(page)).length >= 5, 15000)).ok)
    await ctx.close()
  }
  if (want(5)) {
    const f = { on: true }
    const ctx = await browser.newContext({ viewport: { width: 700, height: 800 } })
    const page = await ctx.newPage()
    const created = await watchNewConversations()
    const count = async () => (await created()).length
    await page.route('**/rest/v1/conversations*', fail(f, 'POST'))
    await page.goto(`${APP}/`, { waitUntil: 'load' })
    const box = page.locator('input[placeholder="Type a message…"]')
    check('the page itself loads fine when conversations cannot be created (it creates none on load)', (await box.count()) > 0 && (await page.locator('[role="alert"]').count()) === 0)
    await box.fill('first message, start will fail')
    await page.keyboard.press('Enter')
    await settle(async () => (await page.locator('[role="alert"]:has-text("failed to send")').count()) > 0, 10000)
    check('the first message cannot start a conversation → announced (role="alert")', (await page.locator('[role="alert"]:has-text("failed to send")').count()) > 0)
    check('  …the draft is back in the box, not lost', (await box.inputValue()) === 'first message, start will fail')
    check('  …and nothing was created', (await count()) === 0, await count())
    f.on = false
    await page.keyboard.press('Enter')
    check('  …retrying without a reload starts the conversation and sends', (await settle(async () => (await page.locator('[role="log"]').innerText()).includes('first message, start will fail'), 10000)).ok)
    // The pending bubble puts the text in the log before the insert has returned, so wait for the row itself.
    const one = await settle(async () => (await count()) === 1, 10000)
    const cid = await page.evaluate(() => Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)))
    if (cid) ids.push(cid)
    check('  …as exactly one conversation', one.ok, await count())
    await ctx.close()
  }
  if (want(5)) {
    // The other half of the two-step first message: the conversation is created, then the MESSAGE insert fails.
    // The conversation now exists with nothing in it; the retry must reuse it, not create a second.
    const f = { on: true }
    const created = await watchNewConversations()
    const describe = async (rows) => JSON.stringify({ rows: await Promise.all(rows.map(async (r) => ({ id: r.id.slice(0, 8), created_at: r.created_at, messages: (await admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', r.id)).count }))) })
    const ctx = await browser.newContext({ viewport: { width: 700, height: 800 } })
    const page = await ctx.newPage()
    await page.route('**/rest/v1/messages*', fail(f, 'POST'))
    await page.goto(`${APP}/`, { waitUntil: 'load' })
    const box = page.locator('input[placeholder="Type a message…"]')
    await box.fill('second step will fail')
    await page.keyboard.press('Enter')
    await settle(async () => (await page.locator('[role="alert"]:has-text("failed to send")').count()) > 0, 10000)
    check('conversation created but the message insert fails → announced (role="alert")', (await page.locator('[role="alert"]:has-text("failed to send")').count()) > 0)
    check('  …the draft is kept', (await box.inputValue()) === 'second step will fail')
    const first = await created()
    for (const c of first) ids.push(c.id)
    check('  …and the (empty) conversation exists exactly once, remembered by the page', first.length === 1 && (await page.evaluate(() => localStorage.getItem('frontdesk:customer-conversation-id'))) === first[0]?.id, await describe(first))
    f.on = false
    await page.keyboard.press('Enter')
    check('  …retry sends the message', (await settle(async () => (await admin.from('messages').select('id').eq('conversation_id', first[0]?.id).eq('body', 'second step will fail')).data?.length === 1, 10000)).ok)
    const after = await created()
    for (const c of after) ids.push(c.id)
    check('  …into the SAME conversation, without creating a second', after.length === 1, await describe(after))
    await ctx.close()
  }
  if (want(5)) {
    // A returning visitor whose remembered conversation cannot be looked up: "couldn't ask" must not read as "none",
    // or the next message would start a second conversation and orphan the first.
    const R = await makeConv({ customer_name: 'A11y Returning' }, [{ body: 'my earlier message' }])
    ids.push(R)
    const f = { on: true }
    const ctx = await browser.newContext({ viewport: { width: 700, height: 800 } })
    await ctx.addInitScript((cid) => localStorage.setItem('frontdesk:customer-conversation-id', cid), R)
    const page = await ctx.newPage()
    await page.route('**/rest/v1/conversations*', fail(f, 'GET'))
    await page.goto(`${APP}/`, { waitUntil: 'load' })
    await settle(async () => (await page.locator('[role="alert"]:has-text("reach your conversation")').count()) > 0, 25000)
    check('remembered conversation cannot be looked up → announced (role="alert")', (await page.locator('[role="alert"]:has-text("reach your conversation")').count()) > 0)
    check('  …no composer is offered, so nothing can start a second conversation', (await page.locator('input[placeholder="Type a message…"]').count()) === 0)
    check('  …and the saved id is kept', (await page.evaluate(() => localStorage.getItem('frontdesk:customer-conversation-id'))) === R)
    const btn = page.getByRole('button', { name: /try again|retry/i })
    check('  …with "Try again"', (await btn.count()) > 0)
    f.on = false
    if ((await btn.count()) > 0) await btn.first().click()
    check('  …which recovers the same conversation, history included', (await settle(async () => (await page.locator('[role="log"]').innerText()).includes('my earlier message'), 15000)).ok)
    await ctx.close()
  }

  // ---------------------------------------------------------------- 6. send fails
  console.log('\n=== 6. Sending a message fails ===')
  if (want(6)) {
    const A = await makeConv({ customer_name: 'A11y SendFail', assigned_agent_id: id['Agent'] }, [{ body: 'hello' }])
    ids.push(A)
    const f = { on: false }
    const { ctx, page } = await newConsole(browser, 'Agent', [['**/rest/v1/messages*', fail(f, 'POST')]])
    await pick(page, 'Agent')
    await until(async () => (await sidebarIds(page)).includes(A), 15000)
    await page.click(`[data-conversation-id="${A}"]`)
    await sleep(1200)
    f.on = true
    const box = page.locator('form[aria-label="Send a message"]:visible input')
    await box.fill('this will not send')
    await page.keyboard.press('Enter')
    await sleep(1500)
    check('a role="alert" says the message failed', await page.locator('[role="alert"]:has-text("failed to send")').count() > 0)
    check('the text is back in the box, not lost', (await box.inputValue()) === 'this will not send')
    check('the pending bubble is gone (it is not shown as sent)', !(await has(page, 'Sending…')) && (await page.locator('[role="log"]:visible p:has-text("this will not send")').count()) === 0)
    check('"Message sent" was NOT announced', !(await heard(page)).some((a) => /Message sent/.test(a.text)))
    f.on = false
    await page.keyboard.press('Enter')
    const sent = await until(async () => (await admin.from('messages').select('id').eq('conversation_id', A).eq('body', 'this will not send')).data?.length === 1, 8000)
    check('pressing Enter again sends it (exactly once)', sent.ok)
    await ctx.close()
  }

  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
