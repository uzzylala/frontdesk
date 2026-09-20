import { useCallback, useEffect, useState } from 'react'
import { postJson } from '../lib/api'
import { CLIENT_TRIGGERS_ROUTING } from '../lib/routingTrigger'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'

const STORAGE_KEY = 'frontdesk:customer-conversation-id'

interface Result {
  loading: boolean
  error: string | null
  /** After a failure to start: try again without reloading the page. */
  retry: () => void
}

type Resolution = { id: string } | { error: string }

/**
 * Shared across effect re-runs. React StrictMode (dev) runs effects twice;
 * without this, each run would insert its own conversation and the first
 * would be orphaned — never stored, never routed, permanently stuck in the
 * queue with no customer attached.
 */
let inFlight: Promise<Resolution> | null = null

async function resolveConversation(): Promise<Resolution> {
  const existingId = localStorage.getItem(STORAGE_KEY)

  if (existingId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', existingId)
      .eq('status', 'open')
      .maybeSingle()

    if (!error && data) return { id: data.id }
    // Stale, closed, or missing — fall through and start a fresh one.
  }

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({})
    .select()
    .single()

  if (insertError || !created) {
    return { error: insertError?.message ?? 'Failed to start conversation' }
  }

  localStorage.setItem(STORAGE_KEY, created.id)

  // Dev-only stand-in for the Database Webhook that routes in production
  // (see lib/routingTrigger.ts). A failure here just leaves the conversation
  // queued — a safe degraded state.
  if (CLIENT_TRIGGERS_ROUTING) {
    postJson('/api/route-conversation', { conversationId: created.id }).catch((err) =>
      console.error('Failed to route new conversation', err),
    )
  }

  return { id: created.id }
}

/**
 * Resolves this customer's own conversation. Unlike the agent console
 * (which lists conversations from Postgres), a customer's browser only ever
 * needs to remember its own — localStorage is the source of truth for
 * "which conversation is mine," falling back to creating a new one.
 */
export function useCustomerConversation(): Result {
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    inFlight ??= resolveConversation().finally(() => {
      inFlight = null
    })

    inFlight.then((result) => {
      if (cancelled) return
      if ('error' in result) {
        setError(result.error)
      } else {
        setConversationId(result.id)
      }
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [setConversationId, attempt])

  const retry = useCallback(() => {
    setError(null)
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  return { loading, error, retry }
}
