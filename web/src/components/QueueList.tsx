import { useEffect, useId, useRef, useState } from 'react'
import type { QueueItem } from '../hooks/useAgentRoster'

/** What became of a Pick up click: it's ours, someone else got there first, or we couldn't tell. */
export type ClaimResult = 'claimed' | 'lost' | 'error'

interface QueueListProps {
  queue: QueueItem[]
  agentNames: Record<string, string>
  onPickUp: (id: string) => Promise<ClaimResult>
}

export function QueueList({ queue, agentNames, onPickUp }: QueueListProps) {
  const [pickingUpId, setPickingUpId] = useState<string | null>(null)
  // An explanation for a row that just disappeared under the user. Lives here,
  // not on the row: the winner's assignment removes the row (and, if it was the
  // last one, this whole list) the instant it arrives, so a note inside the row
  // is gone before anyone can read it.
  const [notice, setNotice] = useState<string | null>(null)
  const noticeRef = useRef<HTMLParagraphElement>(null)
  const headingId = useId()

  // Focus lands on the notice: the button the user was on is gone, which would
  // drop focus onto <body>, and focusing the text is what makes a screen reader
  // read it (so there is no separate live announcement). It goes away once
  // focus moves on.
  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])

  // The other way focus gets stranded: it is on a Pick up button and someone
  // *else* takes that conversation. Remember which button had focus (a blur
  // that leaves the button still in the page means the user moved on; one that
  // doesn't is the button being removed — browsers differ on whether they even
  // fire it, so this doesn't rely on the event).
  const focusedItem = useRef<{ id: string; name: string } | null>(null)
  const myClaims = useRef(new Set<string>())
  useEffect(() => {
    const item = focusedItem.current
    if (!item || myClaims.current.has(item.id) || queue.some((q) => q.id === item.id)) return
    focusedItem.current = null
    if (document.activeElement && document.activeElement !== document.body) return
    // oxlint-disable-next-line react/set-state-in-effect
    setNotice(`${item.name} is no longer in the queue.`)
  }, [queue])

  if (queue.length === 0 && !notice) return null

  async function handlePickUp(id: string, name: string) {
    if (pickingUpId) return // aria-disabled buttons still receive clicks
    setPickingUpId(id)
    setNotice(null)
    myClaims.current.add(id) // its removal is our own doing, not news
    const result = await onPickUp(id)
    setPickingUpId(null)
    if (result === 'lost') {
      setNotice(`${name} was already picked up by another agent.`)
    } else if (result === 'error') {
      myClaims.current.delete(id) // still in the queue, and still someone else's to take
      setNotice(`Couldn't pick up ${name}. Check your connection and try again.`)
    }
  }

  return (
    <section
      aria-labelledby={queue.length > 0 ? headingId : undefined}
      aria-label={queue.length > 0 ? undefined : 'Queue'}
      className="border-b border-slate-200 bg-amber-50 p-3"
    >
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          onBlur={() => setNotice(null)}
          className="mb-2 rounded-md bg-white px-3 py-2 text-xs font-medium text-red-700"
        >
          {notice}
        </p>
      )}
      {queue.length > 0 && (
        <>
          <h2 id={headingId} className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
            Queue ({queue.length}) — waiting for an available agent
          </h2>
          <ul className="space-y-1">
            {queue.map((item) => (
              <li
                key={item.id}
                data-queue-item-id={item.id}
                className="flex items-center justify-between rounded-md bg-white px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-900">{item.customer_name}</span>
                  {item.previous_agent_id && (
                    <p
                      data-reassigned-from={item.previous_agent_id}
                      className="text-xs text-red-700"
                    >
                      Reassigned — {agentNames[item.previous_agent_id] ?? 'an agent'} disconnected
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handlePickUp(item.id, item.customer_name)}
                    onFocus={() => {
                      focusedItem.current = { id: item.id, name: item.customer_name }
                    }}
                    onBlur={(e) => {
                      const button = e.currentTarget
                      queueMicrotask(() => {
                        if (button.isConnected) focusedItem.current = null
                      })
                    }}
                    // aria-disabled, not disabled: a disabled button drops keyboard focus
                    aria-disabled={pickingUpId !== null}
                    aria-label={`${pickingUpId === item.id ? 'Picking up' : 'Pick up'} conversation from ${item.customer_name}`}
                    className="rounded-md bg-indigo-700 px-2 py-1 text-xs font-medium text-white aria-disabled:opacity-60"
                  >
                    {pickingUpId === item.id ? 'Picking up…' : 'Pick up'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
