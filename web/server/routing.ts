import type { SupabaseClient } from '@supabase/supabase-js'
import { HEARTBEAT_STALE_MS } from '../src/lib/presenceConfig.js'
import type { Agent } from '../src/types.js'

type AdminClient = SupabaseClient

type SortKey = [openCount: number, lastAssignedAtMs: number, agentId: string]

function sortKeyFor(agent: Agent, openCount: number): SortKey {
  // null last_assigned_at = never assigned = should win any tie, so it
  // sorts as "earliest possible" rather than "unknown"/last.
  const lastAssignedAtMs = agent.last_assigned_at
    ? new Date(agent.last_assigned_at).getTime()
    : -Infinity
  return [openCount, lastAssignedAtMs, agent.id]
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

/** Agent ids whose heartbeat is fresh, i.e. genuinely connected right now. */
async function fetchConnectedAgentIds(
  admin: AdminClient,
  agentIds: string[],
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set()

  const { data, error } = await admin
    .from('agent_heartbeats')
    .select('agent_id, last_seen_at')
    .in('agent_id', agentIds)
  if (error) throw error

  const cutoff = Date.now() - HEARTBEAT_STALE_MS
  return new Set(
    (data ?? [])
      .filter((beat) => new Date(beat.last_seen_at).getTime() >= cutoff)
      .map((beat) => beat.agent_id as string),
  )
}

/**
 * Least-busy routable agent: status 'online' AND a fresh heartbeat (so an
 * agent whose tab died while still marked online is never routed to), then
 * fewest open conversations, tie-broken by who's gone longest without a new
 * assignment, tie-broken again by agent id for a fully deterministic result.
 */
export async function pickLeastBusyOnlineAgent(admin: AdminClient): Promise<Agent | null> {
  const { data: onlineAgents, error: agentsError } = await admin
    .from('agents')
    .select('*')
    .eq('status', 'online')

  if (agentsError) throw agentsError
  if (!onlineAgents || onlineAgents.length === 0) return null

  const connected = await fetchConnectedAgentIds(
    admin,
    onlineAgents.map((a) => a.id),
  )
  const agents = (onlineAgents as Agent[]).filter((a) => connected.has(a.id))
  if (agents.length === 0) return null

  const { data: openConversations, error: convError } = await admin
    .from('conversations')
    .select('assigned_agent_id')
    .eq('status', 'open')
    .in(
      'assigned_agent_id',
      agents.map((a) => a.id),
    )

  if (convError) throw convError

  const openCounts = new Map<string, number>()
  for (const row of openConversations ?? []) {
    if (!row.assigned_agent_id) continue
    openCounts.set(row.assigned_agent_id, (openCounts.get(row.assigned_agent_id) ?? 0) + 1)
  }

  let best: Agent | null = null
  let bestKey: SortKey | null = null

  for (const agent of agents) {
    const key = sortKeyFor(agent, openCounts.get(agent.id) ?? 0)
    if (!bestKey || compareKeys(key, bestKey) < 0) {
      best = agent
      bestKey = key
    }
  }

  return best
}

export type AssignResult =
  | { status: 'assigned'; agentId: string }
  | { status: 'queued' }
  | { status: 'already-assigned' }

/**
 * Routes a newly created conversation. Called two ways: from a Supabase
 * Database Webhook once this is deployed (the authoritative, guaranteed
 * path — fires regardless of what client created the row), and directly
 * by the customer page/widget during local dev, where there's no public URL
 * for Supabase to call. Both paths hit this exact function.
 */
export async function assignNewConversation(
  admin: AdminClient,
  conversationId: string,
): Promise<AssignResult> {
  const agent = await pickLeastBusyOnlineAgent(admin)
  if (!agent) return { status: 'queued' }

  const { data: updated, error } = await admin
    .from('conversations')
    .update({ assigned_agent_id: agent.id })
    .eq('id', conversationId)
    .is('assigned_agent_id', null)
    .select()

  if (error) throw error
  if (!updated || updated.length === 0) return { status: 'already-assigned' }

  const { error: agentError } = await admin
    .from('agents')
    .update({ last_assigned_at: new Date().toISOString() })
    .eq('id', agent.id)
  if (agentError) throw agentError

  return { status: 'assigned', agentId: agent.id }
}

export type PullQueueResult =
  | { status: 'assigned'; conversationId: string }
  | { status: 'no-queue' }
  | { status: 'not-online' }

/**
 * Called when an agent's status changes to 'online' (or an online agent
 * (re)connects): hands them the oldest queued (unassigned, open)
 * conversation, if any. Uses the same atomic compare-and-set as the manual
 * "pick up" button, so this can't double-assign a conversation that a
 * manual pickup grabs at the same moment — whichever UPDATE lands first
 * wins, the other matches zero rows. No retry-next-oldest on a lost race:
 * at this scale it's not worth the complexity.
 */
export async function pullQueueForAgent(
  admin: AdminClient,
  agentId: string,
): Promise<PullQueueResult> {
  const { data: agent, error: agentError } = await admin
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single()

  if (agentError) throw agentError
  if (agent.status !== 'online') return { status: 'not-online' }

  const connected = await fetchConnectedAgentIds(admin, [agentId])
  if (!connected.has(agentId)) return { status: 'not-online' }

  const { data: queued, error: queueError } = await admin
    .from('conversations')
    .select('id')
    .eq('status', 'open')
    .is('assigned_agent_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (queueError) throw queueError
  if (!queued) return { status: 'no-queue' }

  const { data: claimed, error: claimError } = await admin
    .from('conversations')
    .update({ assigned_agent_id: agentId })
    .eq('id', queued.id)
    .is('assigned_agent_id', null)
    .select()

  if (claimError) throw claimError
  if (!claimed || claimed.length === 0) return { status: 'no-queue' }

  const { error: lastAssignedError } = await admin
    .from('agents')
    .update({ last_assigned_at: new Date().toISOString() })
    .eq('id', agentId)
  if (lastAssignedError) throw lastAssignedError

  return { status: 'assigned', conversationId: queued.id }
}

export type ReapResult =
  | {
      agentId: string
      status: 'reassigned'
      movedToAgents: number
      movedToQueue: number
    }
  | { agentId: string; status: 'nothing-to-reassign' }
  | { agentId: string; status: 'alive' }
  | { agentId: string; status: 'never-connected' }

/**
 * Moves every open conversation off a disconnected agent — to the
 * least-busy connected agent, or back to the queue if nobody's available.
 * Oldest first, re-picking the target each time so load spreads evenly.
 *
 * Each move is a compare-and-set on the *current* assignee, so several
 * consoles sweeping at once (each console does) can't double-move or
 * fight over a conversation: whoever's UPDATE lands first wins and the
 * rest match zero rows.
 */
async function reassignFrom(admin: AdminClient, agentId: string): Promise<ReapResult> {
  const { data: conversations, error } = await admin
    .from('conversations')
    .select('id')
    .eq('status', 'open')
    .eq('assigned_agent_id', agentId)
    .order('created_at', { ascending: true })

  if (error) throw error
  if (!conversations || conversations.length === 0) {
    return { agentId, status: 'nothing-to-reassign' }
  }

  let movedToAgents = 0
  let movedToQueue = 0

  for (const conversation of conversations) {
    const target = await pickLeastBusyOnlineAgent(admin)

    const { data: moved, error: moveError } = await admin
      .from('conversations')
      .update({
        assigned_agent_id: target?.id ?? null,
        previous_agent_id: agentId,
        reassigned_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)
      .eq('assigned_agent_id', agentId)
      .select()

    if (moveError) throw moveError
    if (!moved || moved.length === 0) continue // someone else already moved it

    if (target) {
      movedToAgents++
      const { error: bumpError } = await admin
        .from('agents')
        .update({ last_assigned_at: new Date().toISOString() })
        .eq('id', target.id)
      if (bumpError) throw bumpError
    } else {
      movedToQueue++
    }
  }

  return { agentId, status: 'reassigned', movedToAgents, movedToQueue }
}

/**
 * Reassigns conversations away from agents whose connection has dropped.
 *
 * "Dropped" is decided only by the durable heartbeat going stale — never by
 * whoever calls this claiming an agent left — so a wrong or malicious
 * report can't kick a healthy agent. An agent with no heartbeat row at all
 * has never connected, which isn't a drop, so they're left alone (this is
 * also why seeded demo assignments aren't shuffled around).
 *
 * Pass agentId to check one agent (a presence-leave nudge from a peer);
 * omit it to sweep everyone (the periodic backstop).
 */
export async function reapDisconnectedAgents(
  admin: AdminClient,
  agentId?: string,
): Promise<ReapResult[]> {
  let query = admin.from('agent_heartbeats').select('agent_id, last_seen_at')
  if (agentId) query = query.eq('agent_id', agentId)

  const { data: beats, error } = await query
  if (error) throw error

  if (agentId && (!beats || beats.length === 0)) {
    return [{ agentId, status: 'never-connected' }]
  }

  const cutoff = Date.now() - HEARTBEAT_STALE_MS
  const results: ReapResult[] = []

  for (const beat of beats ?? []) {
    if (new Date(beat.last_seen_at).getTime() >= cutoff) {
      if (agentId) results.push({ agentId, status: 'alive' })
      continue
    }
    results.push(await reassignFrom(admin, beat.agent_id))
  }

  return results
}
