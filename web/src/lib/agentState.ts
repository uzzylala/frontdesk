import type { Agent, AgentStatus } from '../types'

/**
 * What the UI shows for an agent, combining two independent signals:
 *  - intent: agents.status, what the agent last clicked (persists)
 *  - liveness: Realtime Presence, whether their client is actually connected
 *
 * A connected agent shows their intent. A disconnected agent shows
 * 'offline' if they'd already set themselves away (they signed off), or
 * 'disconnected' if their status still says online/busy — they never signed
 * off, so the connection dropped unintentionally.
 */
export type EffectiveAgentState = AgentStatus | 'disconnected' | 'offline'

export function effectiveAgentState(agent: Agent, connected: boolean): EffectiveAgentState {
  if (connected) return agent.status
  return agent.status === 'away' ? 'offline' : 'disconnected'
}

/** Shared by the roster chips and the spoken presence announcements. */
export const AGENT_STATE_LABEL: Record<EffectiveAgentState, string> = {
  online: 'Online',
  busy: 'Busy',
  away: 'Away',
  offline: 'Offline',
  disconnected: 'Disconnected',
}
