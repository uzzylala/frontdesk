import { useState } from 'react'
import type { AgentStatus } from '../types'

const STATUSES: AgentStatus[] = ['online', 'busy', 'away']

// Every chosen state keeps white text at >= 4.5:1 (WCAG AA): emerald-700,
// amber-700 and slate-600 on white. The 500/600 shades this replaced did not.
const STATUS_STYLES: Record<AgentStatus, string> = {
  online: 'bg-emerald-700 text-white',
  busy: 'bg-amber-700 text-white',
  away: 'bg-slate-600 text-white',
}

interface AgentStatusToggleProps {
  status: AgentStatus
  onChange: (status: AgentStatus) => void | Promise<void>
}

/**
 * A native radio group (fieldset + legend + radios) rather than three
 * buttons styled to look selected: assistive tech announces it as
 * "Your status, Online, radio button, 1 of 3, checked", the group is a
 * single Tab stop, and the arrow keys move the selection — all from the
 * platform, none reimplemented. The radios are visually hidden and the
 * labels drawn as pills; the label shows the focus ring.
 *
 * The chosen value is held locally while the save is in flight, so the
 * control doesn't snap back to the old value (and re-announce it) between
 * the click and the server round-trip.
 */
export function AgentStatusToggle({ status, onChange }: AgentStatusToggleProps) {
  const [pending, setPending] = useState<AgentStatus | null>(null)
  const shown = pending ?? status

  async function choose(next: AgentStatus) {
    setPending(next)
    try {
      await onChange(next)
    } finally {
      setPending(null)
    }
  }

  return (
    <fieldset className="flex gap-1" aria-busy={pending !== null}>
      <legend className="sr-only">Your status</legend>
      {STATUSES.map((option) => (
        <label
          key={option}
          className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium capitalize has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-700 ${
            shown === option ? STATUS_STYLES[option] : 'bg-slate-100 text-slate-700'
          }`}
        >
          <input
            type="radio"
            name="agent-status"
            value={option}
            checked={shown === option}
            onChange={() => void choose(option)}
            className="sr-only"
          />
          {option}
        </label>
      ))}
    </fieldset>
  )
}
