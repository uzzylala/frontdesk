import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'

type Mode = 'customer' | 'agent'

interface Result {
  loading: boolean
  error: string | null
}

/**
 * Resolves the single open conversation this phase works with. Customer and
 * agent are separate people on separate machines in reality, so there's no
 * shared localStorage id to hand off — both sides independently look up the
 * same open conversation row in Postgres and converge on it.
 *
 * A customer starting a chat is what should create a conversation; the
 * agent console only ever looks for one that already exists.
 */
export function useActiveConversation(mode: Mode): Result {
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function resolve() {
      const { data: existing, error: selectError } = await supabase
        .from('conversations')
        .select('*')
        .eq('status', 'open')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (cancelled) return

      if (selectError) {
        setError(selectError.message)
        setLoading(false)
        return
      }

      if (existing) {
        setConversationId(existing.id)
        setLoading(false)
        return
      }

      if (mode === 'agent') {
        // No conversation yet — this is a valid empty state, not an error.
        setConversationId(null)
        setLoading(false)
        return
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

      setConversationId(created.id)
      setLoading(false)
    }

    resolve()

    return () => {
      cancelled = true
    }
  }, [mode, setConversationId])

  return { loading, error }
}
