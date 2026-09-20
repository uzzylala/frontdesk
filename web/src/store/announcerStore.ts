import { create } from 'zustand'

/** How long a message stays in the region. Long enough to be read, short enough
 *  that a screen-reader user browsing the page doesn't find a stale one. */
const CLEAR_AFTER_MS = 10_000

interface AnnouncerState {
  text: string
  announce: (text: string) => void
}

let flip = false
let clearTimer: ReturnType<typeof setTimeout> | undefined

/**
 * The single source for the page's polite live region (<LiveRegion />).
 * Screen readers speak a region when its text *changes*, so announcing the
 * same sentence twice in a row needs a difference they can't hear: a
 * trailing non-breaking space, alternated.
 */
export const useAnnouncerStore = create<AnnouncerState>((set) => ({
  text: '',
  announce: (text) => {
    if (!text) return
    flip = !flip
    set({ text: flip ? text : `${text} ` })
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => set({ text: '' }), CLEAR_AFTER_MS)
  },
}))

/** Announce from anywhere, including outside React. */
export function announce(text: string): void {
  useAnnouncerStore.getState().announce(text)
}
