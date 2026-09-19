import { useEffect, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'
import type { Message } from '../types'

/**
 * Keeps one Realtime channel per tracked conversation alive — not just the
 * one the agent currently has open, since a background conversation's
 * unread badge needs to update live too.
 *
 * Channels are imperative resources (open sockets), not React state, so
 * they live in a ref-backed Map rather than in Zustand. Zustand only ever
 * holds the data these channels produce. Each effect run reconciles the
 * map against the current id list: subscribe anything new, tear down
 * anything that dropped out, leave the rest untouched — so switching the
 * *active* conversation never touches subscriptions at all.
 */
export function useConsoleChannels(conversationIds: string[]) {
  const channelsRef = useRef(new Map<string, RealtimeChannel>())

  useEffect(() => {
    const idsSet = new Set(conversationIds)
    const store = useConsoleStore.getState()

    for (const id of conversationIds) {
      if (channelsRef.current.has(id)) continue

      store.setMessagesLoading(id, true)
      store.setConnectionStatus(id, 'connecting')

      // Fetched after SUBSCRIBED (see useConversationChannel for why), and
      // again on every re-subscribe to back-fill messages missed in an outage.
      const loadHistory = async () => {
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', id)
          .order('created_at', { ascending: true })
        if (error) {
          console.error(`Failed to load messages for ${id}`, error)
          useConsoleStore.getState().setConnectionStatus(id, 'error')
        } else {
          useConsoleStore.getState().setMessages(id, data as Message[])
        }
        useConsoleStore.getState().setMessagesLoading(id, false)
      }

      const channel = supabase
        .channel(`conversation:${id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${id}`,
          },
          (payload) => {
            useConsoleStore.getState().receiveMessage(id, payload.new as Message)
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            useConsoleStore.getState().setConnectionStatus(id, 'subscribed')
            void loadHistory()
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            useConsoleStore.getState().setConnectionStatus(id, 'error')
          }
        })

      channelsRef.current.set(id, channel)
    }

    for (const [id, channel] of channelsRef.current) {
      if (!idsSet.has(id)) {
        supabase.removeChannel(channel)
        channelsRef.current.delete(id)
      }
    }
    // conversationIds is derived fresh each render from the store's `order`
    // array; joining to a string gives a stable dependency so this effect
    // only reruns when the actual set of ids changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIds.join('|')])

  useEffect(() => {
    const channels = channelsRef.current
    return () => {
      for (const channel of channels.values()) supabase.removeChannel(channel)
      channels.clear()
    }
  }, [])
}
