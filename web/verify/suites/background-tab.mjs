// Real-Chrome background-tab presence test.
//  - Sam's console runs in a REAL Chrome tab (raw CDP, no Playwright: Playwright pins pages visible
//    and disables background throttling, so it can't reproduce this).
//  - A second tab is opened on top, so Sam's tab is genuinely `hidden`.
//  - Jordan's console runs in headless Playwright as an observer and runs the reaper sweeps.
//  - A plain setInterval(1s) counter in Sam's tab is a CONTROL: if it isn't throttled, Chrome's
//    intensive throttling never engaged and a pass would be meaningless.
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cdpConnect } from '../cdp.mjs'

const APP = process.env.APP ?? 'http://localhost:5173'
const HIDDEN = Number(process.env.HIDDEN ?? 330)
const LABEL = process.env.LABEL ?? 'run'
import { env, assertSafeToRun } from '../lib.mjs'
await assertSafeToRun()
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ZERO = '00000000-0000-0000-0000-000000000000'

let pass = 0, fail = 0
const check = (label, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); if (ok) pass++; else fail++ }

const { data: agents } = await admin.from('agents').select('id,name')
const sam = agents.find((a) => a.name === 'Sam K.')

async function reset() {
  await admin.from('agents').update({ status: 'away', last_assigned_at: null }).neq('id', ZERO)
  await admin.from('agent_heartbeats').delete().neq('agent_id', ZERO)
}
async function cleanupTest(convId) {
  if (convId) await admin.from('conversations').delete().eq('id', convId)
  await reset()
}

await reset()
await admin.from('agents').update({ status: 'online' }).eq('id', sam.id)
const { data: conv, error: convErr } = await admin.from('conversations').insert({ customer_name: 'A11y Throttle Test', assigned_agent_id: sam.id }).select().single()
if (convErr) throw convErr
await admin.from('messages').insert({ conversation_id: conv.id, sender_type: 'customer', body: 'background-tab presence test' })
console.log(`[${LABEL}] test conversation ${conv.id} assigned to Sam K.; app = ${APP}`)

// --- Sam: real Chrome, raw CDP ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bg-'))
const port = 9340 + Math.floor(Math.random() * 50)
const proc = spawn(chromium.executablePath(), [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
await sleep(4000)
const list = async () => (await (await fetch(`http://localhost:${port}/json`)).json()).filter((t) => t.type === 'page')
const br = await cdpConnect((await (await fetch(`http://localhost:${port}/json/version`)).json()).webSocketDebuggerUrl)
const samTab = await cdpConnect((await list())[0].webSocketDebuggerUrl)
let jordanBrowser
try {
  await samTab.send('Page.navigate', { url: `${APP}/agent` })
  for (let i = 0; i < 40 && !(await samTab.eval(`document.body?.innerText.includes('Who are you?')`)); i++) await sleep(500)
  await samTab.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Sam K.')).click()`)
  for (let i = 0; i < 40 && !(await samTab.eval(`!!document.querySelector('h1') && document.querySelector('h1').textContent.includes('Sam K.')`)); i++) await sleep(500)
  await samTab.eval(`window.__ctl = 0; setInterval(() => window.__ctl++, 1000); 1`)

  // --- Jordan: observer + reaper driver (headless Playwright) ---
  jordanBrowser = await chromium.launch()
  const jp = await (await jordanBrowser.newContext({ viewport: { width: 1300, height: 900 } })).newPage()
  await jp.goto(`${APP}/agent`)
  await jp.waitForSelector('h1:has-text("Who are you?")')
  await jp.click('button:has-text("Jordan P.")')
  await jp.waitForSelector('h1:has-text("Jordan P.")')
  const samChip = () => jp.locator(`[data-agent-id="${sam.id}"]`).getAttribute('data-agent-state', { timeout: 1500 }).catch(() => null)
  for (let i = 0; i < 20 && (await samChip()) !== 'online'; i++) await sleep(500)
  check('before hiding: observer sees Sam as online', (await samChip()) === 'online', await samChip())

  // --- hide Sam's tab ---
  await br.send('Target.createTarget', { url: 'about:blank' })
  await sleep(1500)
  check('Sam\'s tab is genuinely hidden', (await samTab.eval('document.visibilityState')) === 'hidden')

  const t0 = Date.now()
  let lastSeen = null, lastChange = Date.now(), maxGap = 0, beats = 0
  const chipSeen = new Set(), assignees = new Set(), bannerSeen = []
  let ctlPrev = await samTab.eval('window.__ctl'), nextLog = 30_000, minCtl = 30
  console.log(`  hidden for ${HIDDEN}s, sampling…`)
  while (Date.now() - t0 < HIDDEN * 1000) {
    const { data: hb } = await admin.from('agent_heartbeats').select('last_seen_at').eq('agent_id', sam.id).maybeSingle()
    if (hb && hb.last_seen_at !== lastSeen) {
      if (lastSeen) { maxGap = Math.max(maxGap, Date.now() - lastChange); beats++ }
      lastSeen = hb.last_seen_at; lastChange = Date.now()
    }
    maxGap = Math.max(maxGap, Date.now() - lastChange)
    chipSeen.add(await samChip())
    const { data: c } = await admin.from('conversations').select('assigned_agent_id').eq('id', conv.id).single()
    assignees.add(c.assigned_agent_id === sam.id ? 'Sam' : c.assigned_agent_id === null ? 'QUEUE' : 'other')
    if (await samTab.eval(`document.body.innerText.includes('Connection lost')`)) bannerSeen.push(Math.round((Date.now() - t0) / 1000))
    if (Date.now() - t0 >= nextLog) {
      const ctl = await samTab.eval('window.__ctl')
      console.log(`   t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  beats so far ${beats}  max heartbeat gap ${(maxGap / 1000).toFixed(1)}s  Sam chip ${[...chipSeen].join('/')}  owner ${[...assignees].join('/')}  control timer fired ${ctl - ctlPrev}x in last 30s (ideal 30)`)
      minCtl = Math.min(minCtl, ctl - ctlPrev); ctlPrev = ctl; nextLog += 30_000
    }
    await sleep(1000)
  }

  console.log('  results:')
  check('CONTROL: a plain setInterval in the hidden tab WAS throttled at some point (test is not vacuous)', minCtl < 10 || HIDDEN < 120, `slowest 30s window: ${minCtl} fires`)
  check(`max gap between heartbeats < 15s stale limit (was ${(maxGap / 1000).toFixed(1)}s, ${beats} beats)`, maxGap < 15_000, maxGap)
  check('observer never saw Sam as disconnected', ![...chipSeen].some((s) => s && s !== 'online'), [...chipSeen])
  check('conversation stayed with Sam (never reassigned)', assignees.size === 1 && assignees.has('Sam'), [...assignees])
  check('Sam\'s own console never showed "Connection lost"', bannerSeen.length === 0, bannerSeen)

  // --- bring Sam's tab back ---
  const tabs = await list()
  const samInfo = tabs.find((t) => t.url.includes('/agent'))
  await br.send('Target.activateTarget', { targetId: samInfo.id })
  await sleep(3000)
  check('after un-hiding: Sam still online in observer', (await samChip()) === 'online', await samChip())
  check('after un-hiding: no banner', !(await samTab.eval(`document.body.innerText.includes('Connection lost')`)))
} finally {
  await jordanBrowser?.close().catch(() => {})
  br.close(); proc.kill()
  await cleanupTest(conv.id)
}
console.log(`\n[${LABEL}] ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
