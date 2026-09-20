import { useEffect, useRef } from 'react'
import { createBatcher, type Batcher } from '../lib/announcementBatcher'
import { formatSupportReplies } from '../lib/formatAnnouncements'
import { announce } from '../store/announcerStore'
import type { Message } from '../types'

/**
 * The customer's side of the same idea (used by the standalone page and the
 * widget): when support replies live, say so — including while the widget is
 * closed, since a visitor with a screen reader has no other way to know.
 *
 * The history that loads with the conversation is recorded as already seen,
 * so reloading doesn't announce old replies as new.
 */
export function useSupportReplyAnnouncements(
  conversationId: string | null,
  messages: Message[],
  messagesLoading: boolean,
) {
  const seen = useRef<Set<string> | null>(null)
  const batcherRef = useRef<Batcher<string> | null>(null)

  useEffect(() => {
    const batcher = createBatcher<string>({
      onFlush: (bodies) => announce(formatSupportReplies(bodies)),
    })
    batcherRef.current = batcher
    return () => {
      batcher.dispose()
      batcherRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!conversationId) {
      seen.current = null
      return
    }
    if (messagesLoading) return

    if (seen.current === null) {
      seen.current = new Set(messages.map((m) => m.id))
      return
    }
    for (const message of messages) {
      if (seen.current.has(message.id)) continue
      seen.current.add(message.id)
      if (message.sender_type === 'agent') batcherRef.current?.push(message.body)
    }
  }, [conversationId, messages, messagesLoading])
}
