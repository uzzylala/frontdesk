/**
 * Facts the console's data layer observes that the announcer may want to say
 * aloud. Producers (the Realtime hooks) emit them; they don't know or care
 * whether anyone is listening, or how it's worded and batched.
 *
 * Only *live* events go through here. Loading history or re-fetching after a
 * reconnect must not, or opening the console would read out the whole inbox.
 */
export type ConsoleEvent =
  | { type: 'message'; conversationId: string; customerName: string }
  | { type: 'assigned'; conversationId: string; customerName: string; previousAgentId: string | null }

type Listener = (event: ConsoleEvent) => void

/**
 * Conversations this agent is claiming from the queue *right now*. The
 * assignment comes back through Realtime as an ordinary "assigned to you"
 * event, but announcing "reassigned to you" to the person who just clicked
 * Pick up is noise, so the claimant registers the id first and the event
 * producer consumes it.
 */
const selfClaims = new Set<string>()
export const expectSelfClaim = (id: string) => void selfClaims.add(id)
export const forgetSelfClaim = (id: string) => void selfClaims.delete(id)
export const consumeSelfClaim = (id: string): boolean => selfClaims.delete(id)

const listeners = new Set<Listener>()

export function emitConsoleEvent(event: ConsoleEvent): void {
  for (const listener of listeners) listener(event)
}

export function onConsoleEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
