export type SenderType = 'customer' | 'agent'

export interface Conversation {
  id: string
  status: 'open' | 'closed'
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
  created_at: string
}
