import { create } from 'zustand'
import type { Message } from '../types'
import type { ConnectionStatus } from './conversationStore'

export interface ConversationEntry {
  id: string
  customerName: string
  messages: Message[]
  messagesLoading: boolean
  connectionStatus: ConnectionStatus
  draft: string
  unreadCount: number
}

interface ConsoleState {
  order: string[]
  conversations: Record<string, ConversationEntry>
  activeConversationId: string | null

  initConversations: (list: { id: string; customerName: string }[]) => void
  addAssignedConversation: (id: string, customerName: string) => void
  reset: () => void
  setActiveConversation: (id: string) => void
  setMessages: (id: string, messages: Message[]) => void
  receiveMessage: (id: string, message: Message) => void
  setDraft: (id: string, draft: string) => void
  setMessagesLoading: (id: string, loading: boolean) => void
  setConnectionStatus: (id: string, status: ConnectionStatus) => void
}

function emptyEntry(id: string, customerName: string): ConversationEntry {
  return {
    id,
    customerName,
    messages: [],
    messagesLoading: true,
    connectionStatus: 'connecting',
    draft: '',
    unreadCount: 0,
  }
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  order: [],
  conversations: {},
  activeConversationId: null,

  initConversations: (list) =>
    set((state) => {
      const conversations = { ...state.conversations }
      for (const { id, customerName } of list) {
        if (!conversations[id]) conversations[id] = emptyEntry(id, customerName)
      }
      return { order: list.map((c) => c.id), conversations }
    }),

  addAssignedConversation: (id, customerName) =>
    set((state) => {
      if (state.order.includes(id)) return state
      const conversations = state.conversations[id]
        ? state.conversations
        : { ...state.conversations, [id]: emptyEntry(id, customerName) }
      return { order: [...state.order, id], conversations }
    }),

  reset: () => set({ order: [], conversations: {}, activeConversationId: null }),

  setActiveConversation: (id) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return { activeConversationId: id }
      return {
        activeConversationId: id,
        conversations: {
          ...state.conversations,
          [id]: { ...entry, unreadCount: 0 },
        },
      }
    }),

  setMessages: (id, messages) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return {
        conversations: { ...state.conversations, [id]: { ...entry, messages } },
      }
    }),

  receiveMessage: (id, message) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      if (entry.messages.some((m) => m.id === message.id)) return state

      const isActive = state.activeConversationId === id
      const isUnread = !isActive && message.sender_type === 'customer'

      return {
        conversations: {
          ...state.conversations,
          [id]: {
            ...entry,
            messages: [...entry.messages, message],
            unreadCount: isUnread ? entry.unreadCount + 1 : entry.unreadCount,
          },
        },
      }
    }),

  setDraft: (id, draft) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return { conversations: { ...state.conversations, [id]: { ...entry, draft } } }
    }),

  setMessagesLoading: (id, messagesLoading) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return {
        conversations: { ...state.conversations, [id]: { ...entry, messagesLoading } },
      }
    }),

  setConnectionStatus: (id, connectionStatus) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return {
        conversations: { ...state.conversations, [id]: { ...entry, connectionStatus } },
      }
    }),
}))
