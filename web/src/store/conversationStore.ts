import { create } from 'zustand'
import type { Message } from '../types'

interface ConversationState {
  conversationId: string | null
  messages: Message[]
  setConversationId: (id: string) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversationId: null,
  messages: [],
  setConversationId: (id) => set({ conversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((m) => m.id === message.id)) return state
      return { messages: [...state.messages, message] }
    }),
}))
