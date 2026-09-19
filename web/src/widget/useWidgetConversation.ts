import { useCallback, useEffect, useRef } from 'react'
import { postJson } from '../lib/api'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'

const STORAGE_KEY = 'frontdesk:widget:conversation-id'

interface Options {
  apiBase: string
  customerName?: string
}

/**
 * Unlike the standalone customer page, the widget lives on someone else's
 * site where most visitors never open it — so it must not create a
 * conversation on page load, or every visitor would leave an empty ghost
 * conversation in the agents' queue. It only *resolves* an existing one
 * (remembered in the host page's localStorage) and creates one lazily, on
 * the visitor's first message.
 */
export function useWidgetConversation({ apiBase, customerName }: Options) {
  const conversationId = useConversationStore((s) => s.conversationId)
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const inFlight = useRef<Promise<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    const existingId = localStorage.getItem(STORAGE_KEY)
    if (!existingId) return

    supabase
      .from('conversations')
      .select('id')
      .eq('id', existingId)
      .eq('status', 'open')
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        if (data) setConversationId(data.id)
        else localStorage.removeItem(STORAGE_KEY)
      })

    return () => {
      cancelled = true
    }
  }, [setConversationId])

  const ensureConversation = useCallback((): Promise<string> => {
    if (conversationId) return Promise.resolve(conversationId)
    if (inFlight.current) return inFlight.current

    inFlight.current = (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .insert(customerName ? { customer_name: customerName } : {})
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('Failed to start conversation')

      localStorage.setItem(STORAGE_KEY, data.id)
      setConversationId(data.id)

      // Stand-in for the Database Webhook that triggers routing in
      // production (see api/route-conversation.ts).
      postJson('/api/route-conversation', { conversationId: data.id }, apiBase).catch((err) =>
        console.error('Failed to route new conversation', err),
      )
      return data.id
    })().finally(() => {
      inFlight.current = null
    })

    return inFlight.current
  }, [conversationId, customerName, apiBase, setConversationId])

  return { conversationId, ensureConversation }
}
