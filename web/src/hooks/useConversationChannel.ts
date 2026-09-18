import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'
import type { Message } from '../types'

/**
 * Loads a conversation's message history and keeps it in sync via a
 * per-conversation Realtime channel. Filtering happens server-side
 * (postgres_changes filter=conversation_id=eq.{id}), so this subscription
 * only ever receives rows for this one conversation — no client-side
 * filtering, no cross-talk with other conversations.
 */
export function useConversationChannel(conversationId: string | null) {
  const setMessages = useConversationStore((s) => s.setMessages)
  const addMessage = useConversationStore((s) => s.addMessage)

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false

    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error('Failed to load messages', error)
          return
        }
        setMessages(data as Message[])
      })

    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          addMessage(payload.new as Message)
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [conversationId, setMessages, addMessage])
}
