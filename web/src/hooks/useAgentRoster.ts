import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'
import type { Conversation } from '../types'

export interface QueueItem {
  id: string
  customer_name: string
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
 * pulls, and manual pickups all show up here without polling. Each event
 * is re-classified from payload.new alone (never payload.old), since
 * Realtime only guarantees old-row data with REPLICA IDENTITY FULL, which
 * this table doesn't set — simpler to not depend on it.
 */
export function useAgentRoster(agentId: string | null): Result {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const initConversations = useConsoleStore((s) => s.initConversations)

  useEffect(() => {
    if (!agentId) return
    let cancelled = false

    Promise.all([
      supabase
        .from('conversations')
        .select('*')
        .eq('assigned_agent_id', agentId)
        .eq('status', 'open')
        .order('created_at', { ascending: true }),
      supabase
        .from('conversations')
        .select('id, customer_name, created_at')
        .is('assigned_agent_id', null)
        .eq('status', 'open')
        .order('created_at', { ascending: true }),
    ]).then(([mineResult, queueResult]) => {
      if (cancelled) return

      if (mineResult.error || queueResult.error) {
        setError((mineResult.error ?? queueResult.error)?.message ?? 'Failed to load conversations')
        setLoading(false)
        return
      }

      initConversations(
        (mineResult.data as Conversation[]).map((c) => ({
          id: c.id,
          customerName: c.customer_name,
        })),
      )
      setQueue(queueResult.data as QueueItem[])
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [agentId, initConversations])

  useEffect(() => {
    if (!agentId) return

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
      .subscribe()

    function classify(row: Conversation) {
      if (row.status !== 'open') {
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
        return
      }

      if (row.assigned_agent_id === agentId) {
        useConsoleStore.getState().addAssignedConversation(row.id, row.customer_name)
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
      } else if (!row.assigned_agent_id) {
        setQueue((prev) =>
          prev.some((q) => q.id === row.id) ? prev : [...prev, row],
        )
      } else {
        // Assigned to a different agent — not (yet) in our queue or ours.
        setQueue((prev) => prev.filter((q) => q.id !== row.id))
      }
    }

    return () => {
      supabase.removeChannel(channel)
    }
  }, [agentId])

  return { queue, loading, error }
}
