import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Agent, AgentStatus } from '../types'

const STORAGE_KEY = 'frontdesk:current-agent-id'

interface Result {
  agents: Agent[]
  currentAgent: Agent | null
  loading: boolean
  error: string | null
  selectAgent: (id: string) => void
  switchAgent: () => void
  setStatus: (status: AgentStatus) => Promise<void>
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

  useEffect(() => {
    let cancelled = false

    supabase
      .from('agents')
      .select('*')
      .order('name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setError(error.message)
        } else {
          setAgents(data as Agent[])
        }
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('agents-roster')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents' },
        (payload) => {
          const updated = payload.new as Agent
          setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agents' },
        (payload) => {
          setAgents((prev) => [...prev, payload.new as Agent])
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const currentAgent = agents.find((a) => a.id === currentAgentId) ?? null

  function selectAgent(id: string) {
    localStorage.setItem(STORAGE_KEY, id)
    setCurrentAgentId(id)
  }

  function switchAgent() {
    localStorage.removeItem(STORAGE_KEY)
    setCurrentAgentId(null)
  }

  async function setStatus(status: AgentStatus) {
    if (!currentAgent) return

    const { error } = await supabase
      .from('agents')
      .update({ status })
      .eq('id', currentAgent.id)

    if (error) {
      console.error('Failed to update status', error)
      return
    }

    setAgents((prev) =>
      prev.map((a) => (a.id === currentAgent.id ? { ...a, status } : a)),
    )

    if (status === 'online') {
      // Stand-in for the Database Webhook that would fire this in
      // production (see api/agent-online.ts header comment).
      try {
        await fetch('/api/agent-online', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: currentAgent.id }),
        })
      } catch (err) {
        console.error('Failed to pull queue after going online', err)
      }
    }
  }

  return { agents, currentAgent, loading, error, selectAgent, switchAgent, setStatus }
}
