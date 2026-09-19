import type { AgentStatus } from '../types'

const STATUSES: AgentStatus[] = ['online', 'busy', 'away']

const STATUS_STYLES: Record<AgentStatus, string> = {
  online: 'bg-emerald-600 text-white',
  busy: 'bg-amber-500 text-white',
  away: 'bg-slate-400 text-white',
}

interface AgentStatusToggleProps {
  status: AgentStatus
  onChange: (status: AgentStatus) => void
}

export function AgentStatusToggle({ status, onChange }: AgentStatusToggleProps) {
  return (
    <div className="flex gap-1">
      {STATUSES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
            status === option ? STATUS_STYLES[option] : 'bg-slate-100 text-slate-600'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
