import { useId, useState } from 'react'
import type { QueueItem } from '../hooks/useAgentRoster'
import { announce } from '../store/announcerStore'

interface QueueListProps {
  queue: QueueItem[]
  agentNames: Record<string, string>
  onPickUp: (id: string) => Promise<boolean>
}

export function QueueList({ queue, agentNames, onPickUp }: QueueListProps) {
  const [pickingUpId, setPickingUpId] = useState<string | null>(null)
  const [missedId, setMissedId] = useState<string | null>(null)
  const headingId = useId()

  if (queue.length === 0) return null

  async function handlePickUp(id: string, name: string) {
    if (pickingUpId) return // aria-disabled buttons still receive clicks
    setPickingUpId(id)
    setMissedId(null)
    const claimed = await onPickUp(id)
    setPickingUpId(null)
    if (!claimed) {
      setMissedId(id)
      // The visible note is easy to miss and silent for a screen reader.
      announce(`${name} was already picked up by another agent.`)
    }
  }

  return (
    <section aria-labelledby={headingId} className="border-b border-slate-200 bg-amber-50 p-3">
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
              {missedId === item.id && (
                <span className="text-xs text-red-700">Already picked up</span>
              )}
              <button
                type="button"
                onClick={() => handlePickUp(item.id, item.customer_name)}
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
    </section>
  )
}
