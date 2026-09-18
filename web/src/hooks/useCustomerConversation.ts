import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'

const STORAGE_KEY = 'frontdesk:customer-conversation-id'

interface Result {
  loading: boolean
  error: string | null
}

/**
 * Resolves this customer's own conversation. Unlike the agent console
 * (which lists every open conversation from Postgres), a customer's browser
 * only ever needs to remember its own — so this uses localStorage as the
 * source of truth for "which conversation is mine," falling back to
 * creating a new one if there's nothing stored yet, or if the stored id no
 * longer points at an open conversation.
 */
export function useCustomerConversation(): Result {
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function resolve() {
      const existingId = localStorage.getItem(STORAGE_KEY)

      if (existingId) {
        const { data, error: selectError } = await supabase
          .from('conversations')
          .select('*')
          .eq('id', existingId)
          .eq('status', 'open')
          .maybeSingle()

        if (cancelled) return

        if (!selectError && data) {
          setConversationId(data.id)
          setLoading(false)
          return
        }
        // Stale, closed, or missing — fall through and start a fresh one.
      }

      const { data: created, error: insertError } = await supabase
        .from('conversations')
        .insert({})
        .select()
        .single()

      if (cancelled) return

      if (insertError || !created) {
        setError(insertError?.message ?? 'Failed to start conversation')
        setLoading(false)
        return
      }

      localStorage.setItem(STORAGE_KEY, created.id)
      setConversationId(created.id)
      setLoading(false)
    }

    resolve()

    return () => {
      cancelled = true
    }
  }, [setConversationId])

  return { loading, error }
}
