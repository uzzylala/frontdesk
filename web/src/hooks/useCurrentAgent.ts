import { useCallback, useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api'
import { CLIENT_TRIGGERS_ROUTING } from '../lib/routingTrigger'
import { supabase } from '../lib/supabase'
import type { Agent, AgentStatus } from '../types'

const STORAGE_KEY = 'frontdesk:current-agent-id'

interface Result {
  agents: Agent[]
  currentAgent: Agent | null
  loading: boolean
  error: string | null
  /** After a failed first load: try again without reloading the page. */
  retry: () => void
  selectAgent: (id: string) => void
  switchAgent: () => void
  /** Resolves false if the change could not be saved. */
  setStatus: (status: AgentStatus) => Promise<boolean>
}

/**
 * Not real authentication — there's no login, no password, no server-
 * verified identity. This is a local picker (remembered in localStorage)
 * that exists only because this phase's requirements (an agent toggles
 * their own status, sees only their own conversations) need *some* notion
 * of "which agent is this browser," and building real auth isn't in scope
 * yet. See supabase/schema.sql's RLS comments for the security
 * implications of this gap.
 */
export function useCurrentAgent(): Result {
  const [agents, setAgents] = useState<Agent[]>([])
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // A fetch races the live channel: a change heard while the query is in
  // flight is newer than the rows it returns. So only the latest fetch may
  // apply, and rows heard live since it started are laid over its result.
  const latestFetch = useRef(0)
  const heardLive = useRef(new Map<string, Agent>())
  const hasLoaded = useRef(false)

  const fetchAgents = useCallback(async () => {
    const mine = ++latestFetch.current
    heardLive.current.clear()

    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .order('name', { ascending: true })
    if (mine !== latestFetch.current) return

    if (error) {
      // A failed *re*-sync keeps what we have; the connection banner already
      // tells the agent the picture may be stale. Only a first load fails loudly.
      if (!hasLoaded.current) setError(error.message)
      else console.error('Failed to refresh agents', error)
    } else {
      hasLoaded.current = true
      setError(null)
      setAgents((data as Agent[]).map((a) => heardLive.current.get(a.id) ?? a))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // fetchAgents only sets state after its await, never synchronously
    // within this effect — the linter can't see through the call.
    // oxlint-disable-next-line react/set-state-in-effect
    void fetchAgents()
  }, [fetchAgents])

  useEffect(() => {
    const channel = supabase
      .channel('agents-roster')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents' },
        (payload) => {
          const updated = payload.new as Agent
          heardLive.current.set(updated.id, updated)
          setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agents' },
        (payload) => {
          const inserted = payload.new as Agent
          heardLive.current.set(inserted.id, inserted)
          setAgents((prev) =>
            prev.some((a) => a.id === inserted.id)
              ? prev.map((a) => (a.id === inserted.id ? inserted : a))
              : [...prev, inserted],
          )
        },
      )
      // Realtime doesn't replay what it missed while disconnected, so every
      // (re)subscribe re-reads the table. The first one also covers the gap
      // between the initial fetch above and this subscription going live.
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void fetchAgents()
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchAgents])

  const retry = useCallback(() => {
    setError(null)
    setLoading(true)
    void fetchAgents()
  }, [fetchAgents])

  const currentAgent = agents.find((a) => a.id === currentAgentId) ?? null

  function selectAgent(id: string) {
    localStorage.setItem(STORAGE_KEY, id)
    setCurrentAgentId(id)
  }

  function switchAgent() {
    localStorage.removeItem(STORAGE_KEY)
    setCurrentAgentId(null)
  }

  async function setStatus(status: AgentStatus): Promise<boolean> {
    if (!currentAgent) return false

    const { error } = await supabase
      .from('agents')
      .update({ status })
      .eq('id', currentAgent.id)

    if (error) {
      console.error('Failed to update status', error)
      return false
    }

    setAgents((prev) =>
      prev.map((a) => (a.id === currentAgent.id ? { ...a, status } : a)),
    )

    if (status === 'online' && CLIENT_TRIGGERS_ROUTING) {
      // Dev-only stand-in for the Database Webhook that fires this in
      // production (see lib/routingTrigger.ts).
      try {
        await postJson('/api/agent-online', { agentId: currentAgent.id })
      } catch (err) {
        console.error('Failed to pull queue after going online', err)
      }
    }
    return true
  }

  return { agents, currentAgent, loading, error, retry, selectAgent, switchAgent, setStatus }
}
