// Keyboard-only walkthrough of the agent console. No mouse events anywhere after page.goto.
import { chromium } from 'playwright'
import { admin, agents, makeConv, cleanup, focusedAx, check, summary, APP, sleep, until } from '../lib.mjs'

const ids = []
const fmt = (a) => `${a.role}${a.states?.length ? ` [${a.states.join(', ')}]` : ''} — "${a.name}"`

async function pressUntil(page, key, predicate, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key)
    const ax = await focusedAx(page)
    if (predicate(ax)) return { ok: true, ax, presses: i + 1 }
  }
  return { ok: false, ax: await focusedAx(page), presses: max }
}

async function main() {
  await cleanup([])
  const id = await agents()
  ids.push(await makeConv({ customer_name: 'A11y Unread', assigned_agent_id: id['Agent'], previous_agent_id: id['Sam K.'] }, [{ body: 'Hello, my order has not arrived.' }]))
  ids.push(await makeConv({ customer_name: 'A11y Quiet', assigned_agent_id: id['Agent'] }, [{ body: 'Thanks for the help!' }]))
  const queued = await makeConv({ customer_name: 'A11y Queued', previous_agent_id: id['Jordan P.'] }, [{ body: 'Anyone there?' }])
  ids.push(queued)

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${APP}/agent`, { waitUntil: 'networkidle' })

  console.log('\n[1] Picking an agent with the keyboard only')
  const pick = await pressUntil(page, 'Tab', (a) => a.role === 'button' && a.name === 'Agent')
  check('Tab reaches the "Agent" button on the picker', pick.ok, pick.ax)
  await page.keyboard.press('Enter')
  await page.waitForSelector('h1:has-text("Agent")')
  await until(async () => (await page.$$('[data-conversation-id]')).length >= 7, 15000)
  await sleep(1500)
  check('page title identifies the page', (await page.title()) === 'Agent — Frontdesk agent console', await page.title())

  console.log('\n[2] TAB ORDER (from a fresh load of the console; focus starts at the document)')
  const freshLoad = async () => { await page.reload({ waitUntil: 'load' }); await until(async () => (await page.$$('[data-conversation-id]')).length >= 7, 15000); await sleep(1000) }
  await freshLoad()
  const stops = []
  const seen = new Set()
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab')
    const ax = await focusedAx(page)
    if (ax.role === '(none)') { console.log('     --  end of the page: focus leaves to the browser UI (wraps around on the next Tab)'); break }
    const key = fmt(ax)
    if (seen.has(key) && stops.length > 3) break
    seen.add(key)
    stops.push(ax)
    console.log(`     ${String(i + 1).padStart(2)}. ${fmt(ax)}`)
  }
  const roles = stops.map((s) => s.role)
  check('first stops are the two skip links', stops[0]?.name === 'Skip to conversations' && stops[1]?.name === 'Skip to message box', stops.slice(0, 2))
  const iSwitch = stops.findIndex((s) => s.name === 'Switch agent')
  const iRadio = stops.findIndex((s) => s.role === 'radio')
  const iPick = stops.findIndex((s) => /^Pick up conversation from/.test(s.name))
  const iConv = stops.findIndex((s) => s.name.startsWith('A11y Unread'))
  const iLog = stops.findIndex((s) => s.role === 'log')
  const iInput = stops.findIndex((s) => s.role === 'textbox')
  check('order: skip links → Switch agent → status → queue → conversations → transcript → message box', iSwitch >= 0 && iSwitch < iRadio && iRadio < iPick && iPick < iConv && iConv < iLog && iLog < iInput, { iSwitch, iRadio, iPick, iConv, iLog, iInput })
  check('the status control is ONE tab stop (radio group), not three', roles.filter((r) => r === 'radio').length === 1, roles.filter((r) => r === 'radio').length)
  check('no tab stop is unnamed', stops.every((s) => s.name.trim().length > 0), stops.filter((s) => !s.name.trim()))

  console.log('\n[3] Skip links')
  await freshLoad()
  await page.keyboard.press('Tab') // skip to conversations
  const sk1 = await focusedAx(page)
  check('first Tab on a fresh load is "Skip to conversations"', sk1.name === 'Skip to conversations', sk1)
  await page.keyboard.press('Enter')
  const afterSk1 = await focusedAx(page)
  // Chrome's accessibility protocol has no property for aria-current, so read the attribute itself.
  const cur = await page.evaluate(() => document.activeElement?.getAttribute('aria-current'))
  check('"Skip to conversations" lands on the open conversation in the list (aria-current=true)', afterSk1.role === 'button' && cur === 'true', { afterSk1, cur })
  await freshLoad()
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab') // skip to message box
  await page.keyboard.press('Enter')
  const afterSk2 = await focusedAx(page)
  check('"Skip to message box" lands in the message box', afterSk2.role === 'textbox' && /^Reply to /.test(afterSk2.name), afterSk2)
  void sk1

  console.log('\n[4] Select a conversation, focus lands in its message box, send, Escape back')
  const tabToQuiet = await pressUntil(page, 'Shift+Tab', (a) => a.name.startsWith('A11y Quiet'), 30)
  check('reached "A11y Quiet" in the list (Shift+Tab back through the page)', tabToQuiet.ok, tabToQuiet.ax)
  console.log(`     focused: ${fmt(tabToQuiet.ax)}`)
  await page.keyboard.press('Enter')
  const inBox = await until(async () => { const a = await focusedAx(page); return a.role === 'textbox' && a.name === 'Reply to A11y Quiet' ? a : null }, 3000)
  check('Enter on a conversation moves focus to its message box ("Reply to A11y Quiet")', inBox.ok, await focusedAx(page))
  const text = `keyboard-only reply ${Date.now()}`
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  const sent = await until(async () => (await admin.from('messages').select('body,sender_type').eq('conversation_id', ids[1])).data?.some((m) => m.body === text && m.sender_type === 'agent'), 8000)
  check('Enter in the message box sends it (row saved as an agent message)', sent.ok)
  const shown = await until(async () => (await page.locator(`[role="log"][aria-label="Conversation with A11y Quiet"] >> text=${text}`).count()) === 1, 6000)
  check('and it appears in that conversation\'s transcript', shown.ok)
  await page.keyboard.press('Escape')
  const back = await focusedAx(page)
  check('Escape returns focus to the conversation list item', back.role === 'button' && back.name.startsWith('A11y Quiet'), back)

  console.log('\n[5] Toggle status with the keyboard')
  const toRadio = await pressUntil(page, 'Shift+Tab', (a) => a.role === 'radio', 30)
  check('reached the status radio group', toRadio.ok, toRadio.ax)
  console.log(`     focused: ${fmt(toRadio.ax)}`)
  check('announced as a radio in a group, current value checked', toRadio.ax.role === 'radio' && toRadio.ax.states.includes('checked=true') && /Away/i.test(toRadio.ax.name), toRadio.ax)
  await page.keyboard.press('ArrowLeft')
  const now = await focusedAx(page)
  console.log(`     after ArrowLeft: ${fmt(now)}`)
  const busy = await until(async () => (await admin.from('agents').select('status').eq('id', id['Agent']).single()).data.status === 'busy', 8000)
  check('ArrowLeft moved the selection to "Busy" and saved it', busy.ok && /Busy/i.test(now.name) && now.states.includes('checked=true'), now)
  await page.keyboard.press('ArrowLeft')
  const online = await until(async () => (await admin.from('agents').select('status').eq('id', id['Agent']).single()).data.status === 'online', 8000)
  check('ArrowLeft again → "Online" saved', online.ok)

  console.log('\n[6] Claim from the queue with the keyboard')
  const toPick = await pressUntil(page, 'Tab', (a) => /^Pick up conversation from A11y Queued/.test(a.name), 30)
  check('reached "Pick up conversation from A11y Queued"', toPick.ok, toPick.ax)
  console.log(`     focused: ${fmt(toPick.ax)}`)
  await page.keyboard.press('Enter')
  const claimed = await until(async () => (await admin.from('conversations').select('assigned_agent_id').eq('id', queued).single()).data.assigned_agent_id === id['Agent'], 10000)
  check('Enter claimed it (assigned to this agent in the database)', claimed.ok)
  const landed = await until(async () => { const a = await focusedAx(page); return a.role === 'textbox' && a.name === 'Reply to A11y Queued' ? a : null }, 8000)
  check('focus moved into the newly claimed conversation\'s message box', landed.ok, await focusedAx(page))

  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
