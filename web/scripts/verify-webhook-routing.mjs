// Proves that Postgres — not any browser — triggers routing on the deployed app.
//
// It uses only the Supabase service-role API: no page, no widget, no console is
// opened, so the only thing that can possibly call /api/route-conversation or
// /api/agent-online is the Database Webhook (supabase/webhooks.sql).
//
//   node --env-file=.env.local scripts/verify-webhook-routing.mjs
//
// Then confirm from the SERVER's side who called (see README, "Verifying that
// routing is webhook-driven"):
//   npx vercel logs --since 5m --json | grep '"fn"'
//
// It temporarily marks agents online and creates test conversations, and
// resets everything afterwards. It refuses to run while a real console is
// connected, so it can't disturb a live session.
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (node --env-file=.env.local ...)')
const admin = createClient(url, key, { auth: { persistSession: false } })

const NONE = '00000000-0000-0000-0000-000000000000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (ok) pass++
  else fail++
}
async function until(fn, timeoutMs, intervalMs = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn()
    if (value) return { ok: true, ms: Date.now() - t0, value }
    await sleep(intervalMs)
  }
  return { ok: false, ms: Date.now() - t0, value: null }
}

const owner = async (id) => (await admin.from('conversations').select('assigned_agent_id').eq('id', id).single()).data?.assigned_agent_id ?? null
// Stand-in for "this agent's console is connected": a fresh heartbeat row, exactly what a real console writes.
const beat = (agentId) => admin.from('agent_heartbeats').upsert({ agent_id: agentId, last_seen_at: new Date().toISOString() })
const setStatus = (agentId, status) => admin.from('agents').update({ status }).eq('id', agentId)
async function reset() {
  await admin.from('agents').update({ status: 'away', last_assigned_at: null }).neq('id', NONE)
  await admin.from('agent_heartbeats').delete().neq('agent_id', NONE)
}

const created = []
try {
  // --- guard: don't trample a live session ---
  const { data: live } = await admin.from('agent_heartbeats').select('agent_id').gte('last_seen_at', new Date(Date.now() - 30_000).toISOString())
  if (live?.length) throw new Error('An agent console is connected right now; close it (or wait 30s) and re-run.')
  const { data: queued } = await admin.from('conversations').select('id').eq('status', 'open').is('assigned_agent_id', null)
  if (queued?.length) throw new Error(`${queued.length} real conversation(s) are already queued; this test needs an empty queue.`)

  const { data: agents } = await admin.from('agents').select('id,name').order('name')
  const [a, b] = agents.filter((x) => x.name !== 'Agent') // two real agents (skip the seeded demo owner)
  await reset()

  // ---------- 1. conversation created -> webhook routes it ----------
  console.log('\n[1] INSERT into conversations -> webhook -> /api/route-conversation')
  await beat(a.id)
  await setStatus(a.id, 'online') // fires the agent-online webhook too (empty queue: a no-op)
  const t1 = Date.now()
  const { data: c1 } = await admin.from('conversations').insert({ customer_name: 'Webhook Test 1' }).select().single()
  created.push(c1.id)
  const routed = await until(async () => owner(c1.id), 25_000)
  check(`new conversation assigned to the online agent (${a.name}) by the webhook, ${(routed.ms / 1000).toFixed(1)}s after insert`, routed.ok && routed.value === a.id, routed.value)
  console.log(`     inserted at ${new Date(t1).toISOString()} — no browser exists in this test`)

  // ---------- 2. agent goes online -> webhook pulls the OLDEST queued ----------
  console.log('\n[2] UPDATE agents SET status=online -> webhook -> /api/agent-online')
  await reset()
  const base = Date.now() - 3_600_000
  const mk = async (n, ageMin) => {
    const { data } = await admin.from('conversations').insert({ customer_name: `Webhook Test Q${n}`, created_at: new Date(base + (10 - ageMin) * 60_000).toISOString() }).select().single()
    created.push(data.id)
    return data.id
  }
  const oldest = await mk(1, 3) // oldest
  const middle = await mk(2, 2)
  const newest = await mk(3, 1)
  await sleep(4_000) // let the three insert-webhooks fire; nobody is online, so all must stay queued
  check('with nobody online, all three stay queued', [await owner(oldest), await owner(middle), await owner(newest)].every((o) => o === null))

  await beat(b.id)
  const t2 = Date.now()
  await setStatus(b.id, 'online') // the "click Online", done in the database
  const pulled = await until(async () => owner(oldest), 25_000)
  check(`${b.name} going online was handed the OLDEST queued conversation, ${((Date.now() - t2) / 1000).toFixed(1)}s later`, pulled.ok && pulled.value === b.id, pulled.value)
  await sleep(1_500)
  check('and only that one: the two newer conversations are still queued', (await owner(middle)) === null && (await owner(newest)) === null)
} finally {
  if (created.length) await admin.from('conversations').delete().in('id', created)
  await reset()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
