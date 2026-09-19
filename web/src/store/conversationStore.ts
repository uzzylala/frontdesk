import { create } from 'zustand'
import { mergeMessages } from '../lib/messages'
import type { Message } from '../types'

export type ConnectionStatus = 'connecting' | 'subscribed' | 'error'

interface ConversationState {
  conversationId: string | null
  messages: Message[]
  messagesLoading: boolean
  connectionStatus: ConnectionStatus
  setConversationId: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  setMessagesLoading: (loading: boolean) => void
  setConnectionStatus: (status: ConnectionStatus) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversationId: null,
  messages: [],
  messagesLoading: true,
  connectionStatus: 'connecting',
  setConversationId: (id) => set({ conversationId: id }),
  setMessages: (messages) =>
    set((state) => ({ messages: mergeMessages(state.messages, messages) })),
  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((m) => m.id === message.id)) return state
      return { messages: [...state.messages, message] }
    }),
  setMessagesLoading: (messagesLoading) => set({ messagesLoading }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
}))
