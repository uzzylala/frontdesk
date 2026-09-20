import { useEffect, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { emitConsoleEvent } from '../lib/consoleEvents'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'
import type { Message } from '../types'

/** Reloaders for each tracked conversation, so the UI can offer "Try again". */
const historyLoaders = new Map<string, () => Promise<void>>()
export const retryHistory = (id: string) => void historyLoaders.get(id)?.()

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
      let loadedBefore = false
      const loadHistory = async () => {
        // A retry from the error state shows the loading state again, rather than
        // a button that seems to do nothing.
        const current = useConsoleStore.getState().conversations[id]
        if (current && current.messages.length === 0) {
          useConsoleStore.getState().setMessagesLoading(id, true)
        }
        useConsoleStore.getState().setHistoryError(id, false)

        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', id)
          .order('created_at', { ascending: true })
        if (error) {
          // Not the connection's fault (the channel may be fine): saying "couldn't
          // connect to live updates" here would mislabel it, and an empty
          // transcript would read as "no messages yet".
          console.error(`Failed to load messages for ${id}`, error)
          useConsoleStore.getState().setHistoryError(id, true)
        } else {
          const history = data as Message[]
          const store = useConsoleStore.getState()
          const entry = store.conversations[id]
          if (loadedBefore && entry) {
            // A re-fetch after an outage: customer messages we've never seen
            // arrived while we weren't listening. They deserve what a live one
            // gets — the unread count and a spoken announcement — not a silent
            // merge into the transcript.
            const known = new Set(entry.messages.map((m) => m.id))
            for (const message of history) {
              if (message.sender_type !== 'customer' || known.has(message.id)) continue
              store.receiveMessage(id, message)
              emitConsoleEvent({ type: 'message', conversationId: id, customerName: entry.customerName })
            }
          }
          loadedBefore = true
          useConsoleStore.getState().setMessages(id, history)
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
            const message = payload.new as Message
            const store = useConsoleStore.getState()
            const entry = store.conversations[id]
            // Only a genuinely new message from the customer is worth
            // saying aloud: not our own reply, and not one that the history
            // fetch already delivered.
            const isNewFromCustomer =
              !!entry &&
              message.sender_type === 'customer' &&
              !entry.messages.some((m) => m.id === message.id)

            store.receiveMessage(id, message)

            if (isNewFromCustomer) {
              emitConsoleEvent({ type: 'message', conversationId: id, customerName: entry.customerName })
            }
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
      historyLoaders.set(id, loadHistory)
    }

    for (const [id, channel] of channelsRef.current) {
      if (!idsSet.has(id)) {
        supabase.removeChannel(channel)
        channelsRef.current.delete(id)
        historyLoaders.delete(id)
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
      historyLoaders.clear()
    }
  }, [])
}
