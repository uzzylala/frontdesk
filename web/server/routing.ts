import type { SupabaseClient } from '@supabase/supabase-js'
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

/**
 * Least-busy online agent: fewest open conversations assigned, tie-broken
 * by who's gone longest without a new assignment, tie-broken again by
 * agent id for a fully deterministic result.
 */
export async function pickLeastBusyOnlineAgent(admin: AdminClient): Promise<Agent | null> {
  const { data: agents, error: agentsError } = await admin
    .from('agents')
    .select('*')
    .eq('status', 'online')

  if (agentsError) throw agentsError
  if (!agents || agents.length === 0) return null

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

  for (const agent of agents as Agent[]) {
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
 * by the customer page during local dev, where there's no public URL for
 * Supabase to call. Both paths hit this exact function.
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
 * Called when an agent's status changes to 'online': hands them the
 * oldest queued (unassigned, open) conversation, if any. Uses the same
 * atomic compare-and-set as the manual "pick up" button, so this can't
 * double-assign a conversation that a manual pickup grabs at the same
 * moment — whichever UPDATE lands first wins, the other matches zero rows.
 * No retry-next-oldest on a lost race: at this scale (single agent coming
 * online at a time in practice) it's not worth the complexity.
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
