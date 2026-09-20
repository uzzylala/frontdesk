import { useCallback, useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'

/**
 * The visitor's remembered conversation, if it still exists and is open.
 * Resolves null only when the server *said* there is none. A failed lookup
 * throws instead: "couldn't ask" must never be read as "there isn't one", or a
 * network blip would erase the saved id and the next message would start a
 * second conversation, orphaning the first.
 */
async function lookUpRemembered(storageKey: string): Promise<string | null> {
  const existingId = localStorage.getItem(storageKey)
  if (!existingId) return null

  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', existingId)
    .eq('status', 'open')
    .maybeSingle()
  if (error) throw error
  if (data) return data.id
  localStorage.removeItem(storageKey) // the server confirmed it's gone or closed
  return null
}

interface Options {
  /** Where this surface remembers its visitor's conversation (the widget and the page keep separate ids). */
  storageKey: string
  /** Origin of the API, when running on a third-party host page. Empty for the same-origin app. */
  apiBase?: string
  customerName?: string
  /** Call the routing endpoint from the browser (local dev). Otherwise the Database Webhook routes. */
  clientRouting?: boolean
}

/**
 * Where the lookup of a remembered conversation stands. 'settled' includes "there was nothing to look up",
 * which is the common case for a first-time visitor and involves no network call at all.
 */
export type LookupStatus = 'resolving' | 'settled' | 'failed'

/**
 * A customer-facing chat surface must not create a conversation on load: most
 * visitors never write, and each would leave an empty ghost conversation in the
 * agents' queue (and be routed to an agent, who would be handed nothing). So
 * this only *resolves* an existing one (remembered in localStorage) and creates
 * one lazily, on the visitor's first message, through `ensureConversation`.
 *
 * Shared by the embeddable widget and the standalone customer page.
 */
export function useLazyConversation({ storageKey, apiBase = '', customerName, clientRouting }: Options) {
  const conversationId = useConversationStore((s) => s.conversationId)
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const startConversation = useConversationStore((s) => s.startConversation)
  const inFlight = useRef<Promise<string> | null>(null)
  const [lookup, setLookup] = useState<LookupStatus>(() =>
    localStorage.getItem(storageKey) ? 'resolving' : 'settled',
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0

    const resolve = async () => {
      try {
        const id = await lookUpRemembered(storageKey)
        if (cancelled) return
        if (id) setConversationId(id)
        setLookup('settled')
      } catch {
        if (cancelled) return
        // Couldn't ask. Keep the saved id and try again, backing off to 30s.
        setLookup('failed')
        timer = setTimeout(resolve, Math.min(30_000, 3_000 * 2 ** tries++))
      }
    }
    void resolve()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [storageKey, setConversationId, attempt])

  /** After a failed lookup: ask again now rather than waiting for the backoff. */
  const retryLookup = useCallback(() => {
    setLookup('resolving')
    setAttempt((n) => n + 1)
  }, [])

  const ensureConversation = useCallback((): Promise<string> => {
    if (conversationId) return Promise.resolve(conversationId)
    if (inFlight.current) return inFlight.current

    inFlight.current = (async () => {
      // If the lookup above hasn't landed (or failed), settle it now: creating
      // a conversation while one may already exist is the mistake to avoid. A
      // failure here fails the send, with the visitor's draft kept.
      const remembered = await lookUpRemembered(storageKey)
      if (remembered) {
        setConversationId(remembered)
        return remembered
      }

      const { data, error } = await supabase
        .from('conversations')
        .insert(customerName ? { customer_name: customerName } : {})
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('Failed to start conversation')

      localStorage.setItem(storageKey, data.id)
      startConversation(data.id)

      // Dev-only stand-in for the Database Webhook that routes in production
      // (see lib/routingTrigger.ts). The host page opts in with
      // data-route-trigger="client"; a real embed doesn't.
      if (clientRouting) {
        postJson('/api/route-conversation', { conversationId: data.id }, apiBase).catch((err) =>
          console.error('Failed to route new conversation', err),
        )
      }
      return data.id
    })().finally(() => {
      inFlight.current = null
    })

    return inFlight.current
  }, [conversationId, storageKey, customerName, apiBase, clientRouting, startConversation, setConversationId])

  return { conversationId, ensureConversation, lookup, retryLookup }
}
