import { AGENT_STATE_LABEL, effectiveAgentState, type EffectiveAgentState } from '../lib/agentState'
import type { Agent } from '../types'

const STATE_STYLE: Record<EffectiveAgentState, { chip: string; dot: string }> = {
  online: { chip: 'bg-emerald-50 text-emerald-800', dot: 'bg-emerald-600' },
  busy: { chip: 'bg-amber-50 text-amber-900', dot: 'bg-amber-600' },
  away: { chip: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  offline: { chip: 'bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
  disconnected: { chip: 'bg-red-50 text-red-800 ring-1 ring-red-200', dot: 'bg-red-600' },
}

interface AgentRosterProps {
  agents: Agent[]
  /** null until the first presence sync — we don't know yet, so don't guess. */
  connectedIds: ReadonlySet<string> | null
  selfId: string
}

export function AgentRoster({ agents, connectedIds, selfId }: AgentRosterProps) {
  return (
    <ul className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-2" aria-label="Agents">
      {agents.map((agent) => {
        // Never treat ourselves as disconnected just because the first
        // sync hasn't landed — if this code is running, we're connected.
        const connected = agent.id === selfId || (connectedIds?.has(agent.id) ?? false)
        const state = connectedIds === null && agent.id !== selfId ? null : effectiveAgentState(agent, connected)
        const style = state ? STATE_STYLE[state] : null

        return (
          <li
            key={agent.id}
            data-agent-id={agent.id}
            data-agent-state={state ?? 'unknown'}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              style?.chip ?? 'bg-slate-50 text-slate-600'
            }`}
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${style?.dot ?? 'bg-slate-400'}`} />
            <span>
              {agent.name}
              {agent.id === selfId && ' (you)'}
            </span>
            <span>· {state ? AGENT_STATE_LABEL[state] : '…'}</span>
          </li>
        )
      })}
    </ul>
  )
}
