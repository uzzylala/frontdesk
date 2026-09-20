import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assignNewConversation,
  pickLeastBusyOnlineAgent,
  pullQueueForAgent,
  QUEUE_SWEEP_MIN_AGE_MS,
  reapDisconnectedAgents,
  routeStrandedQueue,
} from '../../server/routing'
import { HEARTBEAT_STALE_MS } from '../../src/lib/presenceConfig'
import { FakeAdmin } from './fakeAdmin'

const NOW = new Date('2026-06-01T12:00:00.000Z').getTime()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const asAdmin = (db: FakeAdmin) => db as unknown as Parameters<typeof pickLeastBusyOnlineAgent>[0]

// ---- builders -------------------------------------------------------------------------------------------------
const agent = (id: string, status: 'online' | 'busy' | 'away' = 'online', last_assigned_at: string | null = null) => ({ id, name: id, status, last_assigned_at })
const beat = (agent_id: string, msAgo = 1_000) => ({ agent_id, last_seen_at: iso(msAgo) })
const staleBeat = (agent_id: string) => beat(agent_id, HEARTBEAT_STALE_MS + 1_000)
let seq = 0
const conv = (assigned_agent_id: string | null, o: { status?: 'open' | 'closed'; ageMs?: number; id?: string } = {}) => ({
  id: o.id ?? `c${++seq}`,
  status: o.status ?? 'open',
  assigned_agent_id,
  previous_agent_id: null as string | null,
  reassigned_at: null as string | null,
  assigned_via: null as string | null,
  created_at: iso(o.ageMs ?? 60_000),
})
const owner = (db: FakeAdmin, id: string) => db.tables.conversations.find((c) => c.id === id)?.assigned_agent_id
const opens = (db: FakeAdmin, agentId: string) => db.tables.conversations.filter((c) => c.assigned_agent_id === agentId && c.status === 'open').length

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'log').mockImplementation(() => {}) // the routing log lines
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  seq = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('least-busy selection', () => {
  it('picks the online agent with the fewest open conversations', async () => {
    const db = new FakeAdmin({
      agents: [agent('a'), agent('b'), agent('c')],
      agent_heartbeats: [beat('a'), beat('b'), beat('c')],
      conversations: [conv('a'), conv('a'), conv('b'), conv('c'), conv('c'), conv('c')],
    })
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('b')
  })

  it('does not count closed conversations as load', async () => {
    const db = new FakeAdmin({
      agents: [agent('a'), agent('b')],
      agent_heartbeats: [beat('a'), beat('b')],
      conversations: [conv('a', { status: 'closed' }), conv('a', { status: 'closed' }), conv('b')],
    })
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('a')
  })

  it('breaks a tie by who has gone longest without an assignment, never-assigned first', async () => {
    const db = new FakeAdmin({
      agents: [agent('a', 'online', iso(1_000)), agent('b', 'online', iso(9_000)), agent('c', 'online', null)],
      agent_heartbeats: [beat('a'), beat('b'), beat('c')],
    })
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('c') // never assigned wins
    db.tables.agents[2].last_assigned_at = iso(500)
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('b') // then the oldest assignment
  })

  it('breaks a remaining tie deterministically, by agent id', async () => {
    const same = iso(5_000)
    const db = new FakeAdmin({
      agents: [agent('c', 'online', same), agent('a', 'online', same), agent('b', 'online', same)],
      agent_heartbeats: [beat('a'), beat('b'), beat('c')],
    })
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('a')
  })

  it('only routes to agents who are online AND genuinely connected', async () => {
    const db = new FakeAdmin({
      agents: [agent('busy', 'busy'), agent('away', 'away'), agent('stale'), agent('nobeat'), agent('ok')],
      agent_heartbeats: [beat('busy'), beat('away'), staleBeat('stale'), beat('ok')],
      conversations: [conv('ok'), conv('ok'), conv('ok')], // ok is the most loaded, but the only routable one
    })
    expect((await pickLeastBusyOnlineAgent(asAdmin(db)))?.id).toBe('ok')
  })

  it('returns null when nobody is routable', async () => {
    const db = new FakeAdmin({ agents: [agent('a'), agent('b', 'away')], agent_heartbeats: [staleBeat('a'), beat('b')] })
    expect(await pickLeastBusyOnlineAgent(asAdmin(db))).toBeNull()
  })

  it('idleOnly: an agent with anything open does not qualify, an idle one does', async () => {
    const db = new FakeAdmin({
      agents: [agent('a'), agent('b')],
      agent_heartbeats: [beat('a'), beat('b')],
      conversations: [conv('a'), conv('b')],
    })
    expect(await pickLeastBusyOnlineAgent(asAdmin(db), { idleOnly: true })).toBeNull()
    db.tables.conversations.pop() // b is now idle
    expect((await pickLeastBusyOnlineAgent(asAdmin(db), { idleOnly: true }))?.id).toBe('b')
  })
})

describe('assigning a new conversation', () => {
  it('assigns to the least-busy agent, bumps last_assigned_at, and tags how it was routed', async () => {
    const db = new FakeAdmin({
      agents: [agent('a'), agent('b')],
      agent_heartbeats: [beat('a'), beat('b')],
      conversations: [conv('a', { id: 'x' }), conv(null, { id: 'new' })],
    })
    expect(await assignNewConversation(asAdmin(db), 'new')).toEqual({ status: 'assigned', agentId: 'b' })
    expect(owner(db, 'new')).toBe('b')
    expect(db.tables.agents.find((a) => a.id === 'b')?.last_assigned_at).toBe(new Date(NOW).toISOString())
    expect(db.tables.conversations.find((c) => c.id === 'new')?.assigned_via).toBe('webhook') // the default: the database called us
  })

  it('records the given via (a browser-triggered call is not counted as the webhook)', async () => {
    const db = new FakeAdmin({ agents: [agent('a')], agent_heartbeats: [beat('a')], conversations: [conv(null, { id: 'new' })] })
    await assignNewConversation(asAdmin(db), 'new', { via: 'client_trigger' })
    expect(db.tables.conversations[0].assigned_via).toBe('client_trigger')
  })

  it('leaves it queued when nobody is routable', async () => {
    const db = new FakeAdmin({ agents: [agent('a', 'away')], agent_heartbeats: [beat('a')], conversations: [conv(null, { id: 'new' })] })
    expect(await assignNewConversation(asAdmin(db), 'new')).toEqual({ status: 'queued' })
    expect(owner(db, 'new')).toBeNull()
  })

  it('is a compare-and-set: an already-assigned conversation is not taken over', async () => {
    const db = new FakeAdmin({ agents: [agent('a'), agent('b')], agent_heartbeats: [beat('a'), beat('b')], conversations: [conv('a', { id: 'x' })] })
    expect(await assignNewConversation(asAdmin(db), 'x')).toEqual({ status: 'already-assigned' })
    expect(owner(db, 'x')).toBe('a')
  })

  it('a concurrent claim between the pick and the write wins, and routing backs off', async () => {
    const db = new FakeAdmin({ agents: [agent('a'), agent('b')], agent_heartbeats: [beat('a'), beat('b')], conversations: [conv(null, { id: 'x' })] })
    db.hooks.before = ({ table, op }) => {
      if (table === 'conversations' && op === 'update') db.tables.conversations[0].assigned_agent_id = 'b' // someone claims it first
    }
    expect(await assignNewConversation(asAdmin(db), 'x')).toEqual({ status: 'already-assigned' })
    expect(owner(db, 'x')).toBe('b')
  })

  it('routing never fails because assigned_via cannot be written (column not migrated yet), and warns only once', async () => {
    const db = new FakeAdmin({
      agents: [agent('a')],
      agent_heartbeats: [beat('a')],
      conversations: [conv(null, { id: 'x' }), conv(null, { id: 'y' })],
    })
    db.hooks.failUpdate = ({ values }) => ('assigned_via' in values ? { code: 'PGRST204', message: "Could not find the 'assigned_via' column of 'conversations' in the schema cache" } : null)
    vi.resetModules() // the once-only warning flag is module state
    const fresh = await import('../../server/routing')
    expect(await fresh.assignNewConversation(asAdmin(db), 'x')).toEqual({ status: 'assigned', agentId: 'a' })
    expect(await fresh.assignNewConversation(asAdmin(db), 'y')).toEqual({ status: 'assigned', agentId: 'a' })
    expect(owner(db, 'x')).toBe('a')
    expect(owner(db, 'y')).toBe('a')
    expect((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('assigned_via does not exist'))).toHaveLength(1)
  })
})

describe('an agent going online pulls the queue', () => {
  it('hands them the OLDEST queued conversation, and only that one', async () => {
    const db = new FakeAdmin({
      agents: [agent('a')],
      agent_heartbeats: [beat('a')],
      conversations: [conv(null, { id: 'newer', ageMs: 30_000 }), conv(null, { id: 'oldest', ageMs: 90_000 }), conv(null, { id: 'mid', ageMs: 60_000 })],
    })
    expect(await pullQueueForAgent(asAdmin(db), 'a')).toEqual({ status: 'assigned', conversationId: 'oldest' })
    expect(owner(db, 'oldest')).toBe('a')
    expect(owner(db, 'mid')).toBeNull()
    expect(owner(db, 'newer')).toBeNull()
    expect(db.tables.conversations.find((c) => c.id === 'oldest')?.assigned_via).toBe('queue_pull')
  })

  it('does nothing for an agent who is not online, or whose heartbeat is stale', async () => {
    const db = new FakeAdmin({
      agents: [agent('away', 'away'), agent('stale')],
      agent_heartbeats: [beat('away'), staleBeat('stale')],
      conversations: [conv(null)],
    })
    expect(await pullQueueForAgent(asAdmin(db), 'away')).toEqual({ status: 'not-online' })
    expect(await pullQueueForAgent(asAdmin(db), 'stale')).toEqual({ status: 'not-online' })
  })

  it('reports an empty queue, and skips closed conversations', async () => {
    const db = new FakeAdmin({ agents: [agent('a')], agent_heartbeats: [beat('a')], conversations: [conv(null, { status: 'closed' })] })
    expect(await pullQueueForAgent(asAdmin(db), 'a')).toEqual({ status: 'no-queue' })
  })

  it('loses gracefully to a manual pickup that lands first (no double assignment)', async () => {
    const db = new FakeAdmin({ agents: [agent('a')], agent_heartbeats: [beat('a')], conversations: [conv(null, { id: 'x' })] })
    db.hooks.before = ({ table, op }) => {
      if (table === 'conversations' && op === 'update') db.tables.conversations[0].assigned_agent_id = 'someone-else'
    }
    expect(await pullQueueForAgent(asAdmin(db), 'a')).toEqual({ status: 'no-queue' })
    expect(owner(db, 'x')).toBe('someone-else')
  })
})

describe('reassignment when an agent disconnects', () => {
  it('moves the dropped agent’s open conversations to connected agents, oldest first, spreading the load', async () => {
    const db = new FakeAdmin({
      agents: [agent('gone'), agent('b'), agent('c')],
      agent_heartbeats: [staleBeat('gone'), beat('b'), beat('c')],
      conversations: [
        conv('gone', { id: 'g1', ageMs: 300_000 }),
        conv('gone', { id: 'g2', ageMs: 200_000 }),
        conv('gone', { id: 'g3', ageMs: 100_000 }),
        conv('c', { id: 'c-existing' }),
      ],
    })
    const [result] = await reapDisconnectedAgents(asAdmin(db), 'gone')
    expect(result).toMatchObject({ agentId: 'gone', status: 'reassigned', movedToAgents: 3, movedToQueue: 0 })
    expect(opens(db, 'gone')).toBe(0)
    // b (0 open) takes the oldest; then b and c are tied at 1 and b was just assigned, so c is next; then b again.
    expect(owner(db, 'g1')).toBe('b')
    expect(owner(db, 'g2')).toBe('c')
    expect(owner(db, 'g3')).toBe('b')
    for (const id of ['g1', 'g2', 'g3']) {
      const c = db.tables.conversations.find((x) => x.id === id)
      expect(c?.previous_agent_id).toBe('gone') // audit trail
      expect(c?.reassigned_at).toBeTruthy()
      expect(c?.assigned_via).toBe('reassignment')
    }
  })

  it('sends them back to the queue, marked as reassigned, when nobody else is connected', async () => {
    const db = new FakeAdmin({
      agents: [agent('gone'), agent('away', 'away')],
      agent_heartbeats: [staleBeat('gone'), beat('away')],
      conversations: [conv('gone', { id: 'g1' }), conv('gone', { id: 'g2' })],
    })
    const [result] = await reapDisconnectedAgents(asAdmin(db), 'gone')
    expect(result).toMatchObject({ status: 'reassigned', movedToAgents: 0, movedToQueue: 2 })
    for (const id of ['g1', 'g2']) {
      const c = db.tables.conversations.find((x) => x.id === id)
      expect(c?.assigned_agent_id).toBeNull()
      expect(c?.previous_agent_id).toBe('gone')
      expect(c?.assigned_via).toBeNull() // the old tag no longer describes anything
    }
  })

  it('decides from the heartbeat alone: a live agent is never reassigned, whatever the caller claims', async () => {
    const db = new FakeAdmin({ agents: [agent('a'), agent('b')], agent_heartbeats: [beat('a', 4_000), beat('b')], conversations: [conv('a', { id: 'x' })] })
    expect(await reapDisconnectedAgents(asAdmin(db), 'a')).toEqual([{ agentId: 'a', status: 'alive' }])
    expect(owner(db, 'x')).toBe('a')
  })

  it('leaves an agent who never connected alone (no heartbeat row is not a drop)', async () => {
    const db = new FakeAdmin({ agents: [agent('seeded')], conversations: [conv('seeded', { id: 'x' })] })
    expect(await reapDisconnectedAgents(asAdmin(db), 'seeded')).toEqual([{ agentId: 'seeded', status: 'never-connected' }])
    expect(await reapDisconnectedAgents(asAdmin(db))).toEqual([]) // the sweep ignores them too
    expect(owner(db, 'x')).toBe('seeded')
  })

  it('does not move closed conversations', async () => {
    const db = new FakeAdmin({
      agents: [agent('gone'), agent('b')],
      agent_heartbeats: [staleBeat('gone'), beat('b')],
      conversations: [conv('gone', { id: 'open' }), conv('gone', { id: 'done', status: 'closed' })],
    })
    await reapDisconnectedAgents(asAdmin(db), 'gone')
    expect(owner(db, 'open')).toBe('b')
    expect(owner(db, 'done')).toBe('gone')
  })

  it('is a compare-and-set on the current assignee: a conversation someone else already moved is skipped', async () => {
    const db = new FakeAdmin({
      agents: [agent('gone'), agent('b'), agent('c')],
      agent_heartbeats: [staleBeat('gone'), beat('b'), beat('c')],
      conversations: [conv('gone', { id: 'x' })],
    })
    db.hooks.before = ({ table, op }) => {
      if (table === 'conversations' && op === 'update') db.tables.conversations[0].assigned_agent_id = 'c' // a concurrent sweep got there first
    }
    const [result] = await reapDisconnectedAgents(asAdmin(db), 'gone')
    expect(result).toMatchObject({ movedToAgents: 0, movedToQueue: 0 })
    expect(owner(db, 'x')).toBe('c') // not overwritten, not double-moved
    expect(db.tables.conversations[0].previous_agent_id).toBeNull()
  })

  it('the full sweep (no agentId) handles every stale agent, and only the stale ones', async () => {
    const db = new FakeAdmin({
      agents: [agent('s1'), agent('s2'), agent('live')],
      agent_heartbeats: [staleBeat('s1'), staleBeat('s2'), beat('live')],
      conversations: [conv('s1', { id: 'x1' }), conv('s2', { id: 'x2' }), conv('live', { id: 'x3' })],
    })
    const results = await reapDisconnectedAgents(asAdmin(db))
    expect(results.map((r) => `${r.agentId}:${r.status}`).sort()).toEqual(['s1:reassigned', 's2:reassigned'])
    expect(owner(db, 'x1')).toBe('live')
    expect(owner(db, 'x2')).toBe('live')
    expect(owner(db, 'x3')).toBe('live')
  })
})

describe('the stranded-queue recovery sweep', () => {
  it('routes a conversation queued past the age gate to an idle online agent, tagged recovery_sweep', async () => {
    const db = new FakeAdmin({
      agents: [agent('a')],
      agent_heartbeats: [beat('a')],
      conversations: [conv(null, { id: 'stuck', ageMs: QUEUE_SWEEP_MIN_AGE_MS + 1_000 })],
    })
    expect(await routeStrandedQueue(asAdmin(db))).toBe(1)
    expect(owner(db, 'stuck')).toBe('a')
    expect(db.tables.conversations[0].assigned_via).toBe('recovery_sweep')
  })

  it('leaves a fresh conversation alone: the webhook gets its turn first', async () => {
    const db = new FakeAdmin({ agents: [agent('a')], agent_heartbeats: [beat('a')], conversations: [conv(null, { id: 'fresh', ageMs: QUEUE_SWEEP_MIN_AGE_MS - 3_000 })] })
    expect(await routeStrandedQueue(asAdmin(db))).toBe(0)
    expect(owner(db, 'fresh')).toBeNull()
  })

  it('does NOT pile onto an agent who already has something open (the one-pull-on-online rule stands)', async () => {
    const db = new FakeAdmin({
      agents: [agent('a')],
      agent_heartbeats: [beat('a')],
      conversations: [conv('a'), conv(null, { id: 'stuck' })],
    })
    expect(await routeStrandedQueue(asAdmin(db))).toBe(0)
    expect(owner(db, 'stuck')).toBeNull()
    // Not merely "ends up queued": the rollback would also undo a pile-on, but only after the agent had briefly been
    // assigned (and told) it. The idle check must stop it before any write.
    expect(db.writes.filter((w) => w.table === 'conversations')).toHaveLength(0)
  })

  it('fills each idle agent with one, oldest first, and stops when nobody idle is left', async () => {
    const db = new FakeAdmin({
      agents: [agent('a'), agent('b')],
      agent_heartbeats: [beat('a'), beat('b')],
      conversations: [conv(null, { id: 'q1', ageMs: 90_000 }), conv(null, { id: 'q2', ageMs: 80_000 }), conv(null, { id: 'q3', ageMs: 70_000 })],
    })
    expect(await routeStrandedQueue(asAdmin(db))).toBe(2)
    expect(owner(db, 'q1')).not.toBeNull()
    expect(owner(db, 'q2')).not.toBeNull()
    expect(owner(db, 'q1')).not.toBe(owner(db, 'q2'))
    expect(owner(db, 'q3')).toBeNull()
  })

  it('does nothing when no agent is online', async () => {
    const db = new FakeAdmin({ agents: [agent('a', 'away')], agent_heartbeats: [beat('a')], conversations: [conv(null, { id: 'stuck' })] })
    expect(await routeStrandedQueue(asAdmin(db))).toBe(0)
  })

  it('gives its assignment back if a queue pull handed the same agent one in between (the interleaving that the rollback exists for)', async () => {
    const db = new FakeAdmin({
      agents: [agent('a')],
      agent_heartbeats: [beat('a')],
      conversations: [conv(null, { id: 'q1', ageMs: 90_000 }), conv(null, { id: 'q2', ageMs: 80_000 })],
    })
    // Right after the sweep assigns q1 to the idle agent, the "pull" lands and gives them q2 as well.
    let injected = false
    db.hooks.afterUpdate = ({ table, values }) => {
      if (!injected && table === 'conversations' && values.assigned_agent_id === 'a') {
        injected = true
        db.tables.conversations.find((c) => c.id === 'q2')!.assigned_agent_id = 'a'
      }
    }
    expect(await routeStrandedQueue(asAdmin(db))).toBe(0)
    expect(owner(db, 'q2')).toBe('a') // the pull is never undone
    expect(owner(db, 'q1')).toBeNull() // the sweep's own assignment was given back
    expect(opens(db, 'a')).toBe(1) // the agent ends with exactly one
    expect(db.tables.conversations.find((c) => c.id === 'q1')?.assigned_via).toBeNull()
  })
})
