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
 *
 * History is fetched *after* the channel reports SUBSCRIBED, not alongside
 * it: fetching first leaves a window where a message inserted between the
 * fetch and the subscription is never seen. Fetching after closes that
 * window, and doing it on every SUBSCRIBED also back-fills anything missed
 * while the connection was down. Overlap is harmless — messages merge by id.
 */
export function useConversationChannel(conversationId: string | null) {
  const setMessages = useConversationStore((s) => s.setMessages)
  const addMessage = useConversationStore((s) => s.addMessage)
  const setMessagesLoading = useConversationStore((s) => s.setMessagesLoading)
  const setConnectionStatus = useConversationStore((s) => s.setConnectionStatus)

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false
    // A conversation we created ourselves a moment ago has nothing to load;
    // showing "Loading…" for it is a flash, and a spoken one. The history
    // fetch after SUBSCRIBED still runs, for anything that arrives meanwhile.
    if (useConversationStore.getState().freshConversationId !== conversationId) {
      setMessagesLoading(true)
    }
    setConnectionStatus('connecting')

    async function loadHistory() {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (error) {
        console.error('Failed to load messages', error)
        setConnectionStatus('error')
      } else {
        setMessages(data as Message[])
      }
      setMessagesLoading(false)
    }

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
      .subscribe((status) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('subscribed')
          void loadHistory()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnectionStatus('error')
        }
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [conversationId, setMessages, addMessage, setMessagesLoading, setConnectionStatus])
}
