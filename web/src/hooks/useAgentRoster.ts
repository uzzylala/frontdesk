import { useCallback, useEffect, useState } from 'react'
import { consumeSelfClaim, emitConsoleEvent } from '../lib/consoleEvents'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'
import type { Conversation } from '../types'

export interface QueueItem {
  id: string
  customer_name: string
  previous_agent_id: string | null
  created_at: string
}

interface Result {
  queue: QueueItem[]
  loading: boolean
  error: string | null
}

/**
 * Scoped at the query level: "mine" is fetched with
 * .eq('assigned_agent_id', agentId), not fetched-all-then-filtered in JS.
 * See the phase 3 write-up for what this does and doesn't guarantee
 * without real auth.
 *
 * A single Realtime channel on the conversations table (unfiltered — every
 * INSERT/UPDATE) keeps both "mine" and the queue live: routing, queue
 * pulls, manual pickups, and disconnect reassignment all show up here
 * without polling. Each event is re-classified from payload.new alone
 * (never payload.old), since Realtime only guarantees old-row data with
 * REPLICA IDENTITY FULL, which this table doesn't set.
 *
 * Realtime doesn't replay events missed while disconnected, so this hook
 * re-reads both lists itself whenever its channel re-subscribes. Conversations
 * that turn out to have been assigned to this agent during the gap are
 * announced, exactly as if they'd arrived live — a screen-reader user
 * shouldn't learn about them only by stumbling on the list.
 */
export function useAgentRoster(agentId: string | null): Result {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const initConversations = useConsoleStore((s) => s.initConversations)

  const refetch = useCallback(async ({ announceNew = false } = {}) => {
    if (!agentId) return

    const [mineResult, queueResult] = await Promise.all([
      supabase
        .from('conversations')
        .select('*')
        .eq('assigned_agent_id', agentId)
        .eq('status', 'open')
        .order('created_at', { ascending: true }),
      supabase
        .from('conversations')
        .select('id, customer_name, previous_agent_id, created_at')
        .is('assigned_agent_id', null)
        .eq('status', 'open')
        .order('created_at', { ascending: true }),
    ])

    if (mineResult.error || queueResult.error) {
      setError((mineResult.error ?? queueResult.error)?.message ?? 'Failed to load conversations')
      setLoading(false)
      return
    }

    setError(null)
    const mine = mineResult.data as Conversation[]
    // Read after the awaits: a live event may have added some while we waited.
    const alreadyHad = new Set(useConsoleStore.getState().order)
    initConversations(
      mine.map((c) => ({
        id: c.id,
        customerName: c.customer_name,
        previousAgentId: c.previous_agent_id,
      })),
    )
    setQueue(queueResult.data as QueueItem[])
    setLoading(false)

    if (announceNew) {
      for (const c of mine) {
        if (alreadyHad.has(c.id) || consumeSelfClaim(c.id)) continue
        emitConsoleEvent({
          type: 'assigned',
          conversationId: c.id,
          customerName: c.customer_name,
          previousAgentId: c.previous_agent_id,
        })
      }
    }
  }, [agentId, initConversations])

  useEffect(() => {
    // refetch only sets state after its awaits resolve, never synchronously
    // within this effect — the linter can't see through the call.
    // oxlint-disable-next-line react/set-state-in-effect
    void refetch()
  }, [refetch])

  useEffect(() => {
    if (!agentId) return

    let subscribedBefore = false
    const channel = supabase
      .channel(`roster:${agentId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        (payload) => classify(payload.new as Conversation),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        (payload) => classify(payload.new as Conversation),
      )
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        // The first subscribe only closes the gap since the initial load and
        // isn't news; a later one is a reconnect, and what it finds is.
        void refetch({ announceNew: subscribedBefore })
        subscribedBefore = true
      })

    function classify(row: Conversation) {
      const store = useConsoleStore.getState()

      if (row.status !== 'open') {
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
        store.removeConversation(row.id)
        return
      }

      if (row.assigned_agent_id === agentId) {
        const isNew = !store.order.includes(row.id)
        store.addAssignedConversation({
          id: row.id,
          customerName: row.customer_name,
          previousAgentId: row.previous_agent_id,
        })
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
        if (isNew && !consumeSelfClaim(row.id)) {
          emitConsoleEvent({
            type: 'assigned',
            conversationId: row.id,
            customerName: row.customer_name,
            previousAgentId: row.previous_agent_id,
          })
        }
      } else if (!row.assigned_agent_id) {
        // Unassigned: it's in the queue — and if it was ours a moment ago
        // (reassigned away after a disconnect), it's no longer.
        store.removeConversation(row.id)
        setQueue((prev) =>
          prev.some((q) => q.id === row.id)
            ? prev.map((q) => (q.id === row.id ? { ...q, ...row } : q))
            : [...prev, row],
        )
      } else {
        // Assigned to a different agent — not in our queue, and not ours.
        store.removeConversation(row.id)
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
      }
    }

    return () => {
      supabase.removeChannel(channel)
    }
  }, [agentId, refetch])

  return { queue, loading, error }
}
