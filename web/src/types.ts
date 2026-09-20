export type SenderType = 'customer' | 'agent'
export type AgentStatus = 'online' | 'busy' | 'away'

export interface Conversation {
  id: string
  status: 'open' | 'closed'
  customer_name: string
  assigned_agent_id: string | null
  previous_agent_id: string | null
  reassigned_at: string | null
  /** How the current assignee got it; null for manual pickups and the queue. */
  assigned_via?: string | null
  created_at: string
}

export interface Message {
  id: string
  conversation_id: string
  sender_type: SenderType
  body: string
  created_at: string
}

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  last_assigned_at: string | null
  created_at: string
}
