/**
 * Coalesces a burst of items into one callback, for screen-reader
 * announcements: a support console can receive a dozen messages in a few
 * seconds, and speaking each one would bury the user.
 *
 * Two timers, deliberately:
 *  - a quiet-period timer, restarted by every push, so a burst is flushed
 *    once it settles;
 *  - a max-wait timer, started by the first item of a batch and never
 *    restarted, so a burst that never settles is still flushed periodically
 *    instead of being deferred forever.
 */
export const ANNOUNCE_QUIET_MS = 1500
export const ANNOUNCE_MAX_WAIT_MS = 6000

export interface Batcher<T> {
  push: (item: T) => void
  /** Flush now (no-op when empty). */
  flush: () => void
  /** Drop anything pending and stop timers. */
  dispose: () => void
}

interface BatcherOptions<T> {
  quietMs?: number
  maxWaitMs?: number
  onFlush: (items: T[]) => void
}

export function createBatcher<T>({
  quietMs = ANNOUNCE_QUIET_MS,
  maxWaitMs = ANNOUNCE_MAX_WAIT_MS,
  onFlush,
}: BatcherOptions<T>): Batcher<T> {
  let items: T[] = []
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  function clearTimers() {
    clearTimeout(quietTimer)
    clearTimeout(maxTimer)
    quietTimer = undefined
    maxTimer = undefined
  }

  function flush() {
    clearTimers()
    if (items.length === 0) return
    const batch = items
    items = []
    onFlush(batch)
  }

  return {
    push(item) {
      items.push(item)
      clearTimeout(quietTimer)
      quietTimer = setTimeout(flush, quietMs)
      maxTimer ??= setTimeout(flush, maxWaitMs)
    },
    flush,
    dispose() {
      clearTimers()
      items = []
    },
  }
}
