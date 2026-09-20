// conversations.assigned_via (supabase/assigned-via.sql) against the real database: each server-side path must leave
// its own tag, so "how often is the routing webhook failing?" can be answered from the data.
//
// Skipped (exit 77) until the migration has been applied — the app works without the column, so its absence is not
// a failure, but neither is a skipped suite a pass, and the runner reports it as skipped.
//
// Note the webhook-driven cases run against the PRODUCTION functions (the database calls the deployed URL), so they
// verify the deployed code, not just the local checkout.
import { chromium } from 'playwright'
import { admin, agents, anonClient, cleanup, openConsole, check, summary, sleep, until } from '../lib.mjs'

const probe = await admin.from('conversations').select('assigned_via').limit(1)
const columnMissing = !!probe.error
if (columnMissing) {
  console.log('SKIPPED: conversations.assigned_via does not exist yet. Run supabase/assigned-via.sql in the Supabase SQL editor, then re-run.')
  console.log(`  (${probe.error.message})`)
  // exitCode, not process.exit(): on Windows, exiting while a fetch handle is still closing crashes Node (libuv assertion).
  process.exitCode = 77
}

const ids = []
const row = async (id) => (await admin.from('conversations').select('assigned_agent_id,previous_agent_id,assigned_via').eq('id', id).single()).data
const insert = async (name, extra = {}) => {
  const { data } = await admin.from('conversations').insert({ customer_name: `A11y Via ${name}`, ...extra }).select().single()
  ids.push(data.id)
  return data.id
}

async function main() {
  await cleanup()
  const id = await agents()
  const browser = await chromium.launch()
  const jordan = await openConsole(browser, 'Jordan P.') // connected: heartbeats, and it runs the periodic sweep
  await sleep(3000)

  console.log('\n[1] webhook: a new conversation routed by the database calling the function')
  await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
  await sleep(2500)
  const c1 = await insert('webhook')
  const r1 = await until(async () => (await row(c1)).assigned_agent_id === id['Jordan P.'], 20000)
  check('routed to the online agent', r1.ok)
  check('tagged "webhook"', (await row(c1)).assigned_via === 'webhook', await row(c1))

  console.log('\n[2] queue_pull: an agent coming online is handed the oldest queued conversation')
  await admin.from('agents').update({ status: 'away' }).eq('id', id['Jordan P.'])
  await sleep(1500)
  const c2 = await insert('queue pull')
  await sleep(2000)
  check('queued while nobody is online', (await row(c2)).assigned_agent_id === null)
  check('a queued conversation carries no tag', (await row(c2)).assigned_via === null)
  await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
  const r2 = await until(async () => (await row(c2)).assigned_agent_id === id['Jordan P.'], 20000)
  check('pulled by the agent who came online', r2.ok)
  check('tagged "queue_pull"', (await row(c2)).assigned_via === 'queue_pull', await row(c2))

  console.log('\n[3] recovery_sweep: a conversation whose routing call was lost, rescued by the fallback')
  await admin.from('conversations').delete().eq('id', c1) // Jordan is idle again
  await admin.from('conversations').delete().eq('id', c2)
  const c3 = await insert('recovery sweep')
  await until(async () => (await row(c3)).assigned_agent_id === id['Jordan P.'], 20000)
  await admin.from('conversations').update({ assigned_agent_id: null, assigned_via: null }).eq('id', c3) // as if that call had been lost
  const r3 = await until(async () => (await row(c3)).assigned_agent_id === id['Jordan P.'], 45000, 500)
  check('rescued by the sweep', r3.ok)
  check('tagged "recovery_sweep" (distinguishable from the webhook)', (await row(c3)).assigned_via === 'recovery_sweep', await row(c3))

  console.log('\n[4] manual: a pickup happens in the browser and is deliberately left untagged')
  await admin.from('agents').update({ status: 'away' }).eq('id', id['Jordan P.'])
  await admin.from('conversations').delete().eq('id', c3)
  await sleep(1500)
  const c4 = await insert('manual')
  await sleep(1500)
  const claim = await anonClient().from('conversations').update({ assigned_agent_id: id['Sam K.'] }).eq('id', c4).is('assigned_agent_id', null).select()
  check('claimed with the anon key, as a browser does', claim.data?.length === 1)
  check('and the tag stays NULL', (await row(c4)).assigned_via === null, await row(c4))

  console.log('\n[5] reassignment: the reaper moves a dropped agent\'s conversation, and says so')
  const sam = await openConsole(browser, 'Sam K.')
  await admin.from('agents').update({ status: 'online' }).eq('id', id['Sam K.'])
  await admin.from('agents').update({ status: 'online' }).eq('id', id['Jordan P.'])
  await sleep(2500)
  await admin.from('conversations').delete().eq('id', c4)
  const c5 = await insert('reassignment', { assigned_agent_id: id['Jordan P.'] })
  await jordan.ctx.close() // Jordan's connection dies
  const r5 = await until(async () => (await row(c5)).assigned_agent_id === id['Sam K.'], 90000, 1000)
  check('moved to the other connected agent after the heartbeat went stale', r5.ok, await row(c5))
  check('tagged "reassignment", with the audit trail intact', (await row(c5)).assigned_via === 'reassignment' && (await row(c5)).previous_agent_id === id['Jordan P.'], await row(c5))
  await sam.ctx.close()
  await browser.close()
}
if (!columnMissing) {
  try {
    await main()
  } finally {
    await cleanup(ids)
  }
  process.exitCode = summary() ? 1 : 0
}
