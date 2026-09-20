// "The routing webhook didn't fire": a conversation sits in the queue although an online, connected, idle agent exists.
// I can't switch off the production trigger, but I can create exactly the resulting state: let the real webhook route a
// conversation (positive control), then put it back in the queue as if that call had been lost.
import { chromium } from 'playwright'
import { admin, agents, cleanup, openConsole, check, summary, sleep, until } from '../lib.mjs'

const ids = []
const owner = async (cid) => (await admin.from('conversations').select('assigned_agent_id').eq('id', cid).single()).data.assigned_agent_id
async function main() {
  await cleanup([])
  const id = await agents()
  const browser = await chromium.launch()
  await openConsole(browser, 'Jordan P.') // a connected console: heartbeats + runs the periodic sweep
  await sleep(2500)
  await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.']) // no queue yet, so nothing to pull
  await sleep(2500)

  const { data: conv } = await admin.from('conversations').insert({ customer_name: 'A11y Lost Webhook' }).select().single()
  ids.push(conv.id)
  await admin.from('messages').insert({ conversation_id: conv.id, sender_type: 'customer', body: 'is anyone there?' })
  const routed = await until(async () => (await owner(conv.id)) === id['Jordan P.'], 15000)
  check('control: the real webhook routes a new conversation to the online agent', routed.ok)

  console.log('\n-- the webhook call is "lost": the conversation is back in the queue, Jordan is online, connected and idle --')
  await admin.from('conversations').update({ assigned_agent_id: null }).eq('id', conv.id)
  const t0 = Date.now()
  const recovered = await until(async () => (await owner(conv.id)) === id['Jordan P.'], 45000, 500)
  console.log(`   waited ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  check('a queued conversation with an idle online agent gets routed without any new trigger', recovered.ok, `still queued after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  // Worst case by design: the 15s age gate + one 10s sweep interval + network latency. 25.1s was observed, so the
  // bound has to allow for latency rather than equal the sum of the two intervals.
  if (recovered.ok) check('within the age gate + one sweep interval + latency (<= 32s)', recovered.ms <= 32000, `${(recovered.ms / 1000).toFixed(1)}s`)
  console.log('\n-- counter-case: the agent already has one conversation open; a second stranded one must NOT be piled on --')
  await admin.from('conversations').update({ assigned_agent_id: id['Jordan P.'] }).eq('id', conv.id) // Jordan now has one open
  const { data: conv2 } = await admin.from('conversations').insert({ customer_name: 'A11y Lost Webhook 2' }).select().single()
  ids.push(conv2.id)
  await sleep(4000) // let the real webhook have its say: it would route to Jordan (least-busy online), so undo that
  await admin.from('conversations').update({ assigned_agent_id: null }).eq('id', conv2.id)
  await sleep(40000) // > 15s age gate + a couple of sweeps
  check('an agent who is not idle is not handed the backlog by the sweep (the one-pull-per-online rule stands)', (await owner(conv2.id)) === null, await owner(conv2.id))
  await browser.close()
}
try { await main() } finally { await cleanup(ids) }
process.exit(summary() ? 1 : 0)
