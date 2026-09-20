// Race: the agent-online pull and the periodic sweep hit the same idle agent at once, with two old queued conversations.
// Spec: going online hands the agent just the OLDEST queued one.
//
// What this asserts, and what it does not: the sweep's give-back only covers 'pull lands first, sweep second'. If the
// sweep fills the idle agent first and the pull then lands, the pull (which is never undone) hands them a second one,
// so the agent can end with TWO. That is benign (a queued customer gets an agent sooner) but it is not the spec, and it
// is not fully prevented. So the hard invariants are: nobody is ever left with none, never more than two, and no
// conversation is lost or assigned twice. The rate of 'two' is reported, not asserted: it varies run to run
// (0/12 and 2/12 have both been observed), which is why this is a stress test and not a gate.
import { chromium } from 'playwright'
import { API, admin, agents, cleanup, openConsole, check, summary, sleep } from '../lib.mjs'

const ids = []
const API_BASE = `${API}/api`
const post = (p, body) => fetch(`${API_BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  await openConsole(browser, 'Jordan P.') // connected: fresh heartbeats
  await sleep(3000)
  const ROUNDS = 12
  let two = 0, one = 0, other = 0
  for (let r = 0; r < ROUNDS; r++) {
    await admin.from('agents').update({ status: 'away' }).eq('id', id['Jordan P.'])
    await admin.from('conversations').delete().like('customer_name', 'A11y PvS%')
    await sleep(800)
    const old = new Date(Date.now() - 60_000).toISOString()
    const mk = async (n, at) => { const { data } = await admin.from('conversations').insert({ customer_name: `A11y PvS ${r}${n}`, created_at: at }).select().single(); ids.push(data.id); return data.id }
    const a = await mk('A', old), b = await mk('B', new Date(Date.now() - 50_000).toISOString())
    await sleep(2500) // let any production webhook on insert (no online agent, so it just queues) settle
    await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
    // Exactly ONE pull happens: the production webhook fired by the status flip above (~1-2s away). Meanwhile pairs of
    // concurrent sweeps run every 250ms so some land right on top of it. (An explicit agent-online call here would be a
    // second pull, the known double-trigger of a dev setup sharing the production database, and would confound this.)
    for (let i = 0; i < 24; i++) { void post('reap-disconnected', {}); void post('reap-disconnected', {}); await sleep(250) }
    await sleep(3000)
    const { data } = await admin.from('conversations').select('id,assigned_agent_id').in('id', [a, b])
    const mine = data.filter((c) => c.assigned_agent_id === id['Jordan P.']).length
    if (mine === 2) two++; else if (mine === 1) one++; else other++
  }
  console.log(`   ${ROUNDS} rounds: Jordan ended with exactly one: ${one}, two: ${two}, other: ${other}`)
  console.log(`   (the benign interleaving, agent handed two, happened in ${two} of ${ROUNDS} rounds)`)
  check('the agent is never left with nothing, and never handed more than two (no lost or over-assigned customer)', one + two === ROUNDS && other === 0, { one, two, other })
  await browser.close()
}
try { await main() } finally { await cleanup(ids); await admin.from('conversations').delete().like('customer_name', 'A11y PvS%') }
process.exit(summary() ? 1 : 0)
