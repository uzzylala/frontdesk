import { create } from 'zustand'
import { mergeMessages } from '../lib/messages'
import type { Message } from '../types'
import type { ConnectionStatus } from './conversationStore'

export interface ConversationEntry {
  id: string
  customerName: string
  previousAgentId: string | null
  messages: Message[]
  messagesLoading: boolean
  /** The last attempt to load this conversation's history failed. */
  historyError: boolean
  connectionStatus: ConnectionStatus
  draft: string
  unreadCount: number
}

export interface AssignedConversation {
  id: string
  customerName: string
  previousAgentId: string | null
}

interface ConsoleState {
  order: string[]
  conversations: Record<string, ConversationEntry>
  activeConversationId: string | null

  initConversations: (list: AssignedConversation[]) => void
  addAssignedConversation: (conversation: AssignedConversation) => void
  removeConversation: (id: string) => void
  reset: () => void
  setActiveConversation: (id: string) => void
  setMessages: (id: string, messages: Message[]) => void
  receiveMessage: (id: string, message: Message) => void
  setDraft: (id: string, draft: string) => void
  setMessagesLoading: (id: string, loading: boolean) => void
  setHistoryError: (id: string, failed: boolean) => void
  setConnectionStatus: (id: string, status: ConnectionStatus) => void
}

function emptyEntry({ id, customerName, previousAgentId }: AssignedConversation): ConversationEntry {
  return {
    id,
    customerName,
    previousAgentId,
    messages: [],
    messagesLoading: true,
    historyError: false,
    connectionStatus: 'connecting',
    draft: '',
    unreadCount: 0,
  }
}

/** Keep the current selection if it's still valid, otherwise fall back to the first. */
function validActive(active: string | null, order: string[]): string | null {
  return active && order.includes(active) ? active : (order[0] ?? null)
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  order: [],
  conversations: {},
  activeConversationId: null,

  initConversations: (list) =>
    set((state) => {
      const conversations = { ...state.conversations }
      for (const c of list) {
        conversations[c.id] = conversations[c.id]
          ? { ...conversations[c.id], previousAgentId: c.previousAgentId }
          : emptyEntry(c)
      }
      const order = list.map((c) => c.id)
      return {
        order,
        conversations,
        activeConversationId: validActive(state.activeConversationId, order),
      }
    }),

  addAssignedConversation: (conversation) =>
    set((state) => {
      if (state.order.includes(conversation.id)) return state
      const conversations = state.conversations[conversation.id]
        ? state.conversations
        : { ...state.conversations, [conversation.id]: emptyEntry(conversation) }
      const order = [...state.order, conversation.id]
      return {
        order,
        conversations,
        activeConversationId: validActive(state.activeConversationId, order),
      }
    }),

  removeConversation: (id) =>
    set((state) => {
      if (!state.order.includes(id)) return state
      const order = state.order.filter((x) => x !== id)
      return {
        order,
        activeConversationId: validActive(state.activeConversationId, order),
      }
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

  // Merge rather than replace: history is fetched after the channel
  // subscribes, so a live message may already be in the list.
  setMessages: (id, messages) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return {
        conversations: {
          ...state.conversations,
          [id]: { ...entry, messages: mergeMessages(entry.messages, messages) },
        },
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

  setHistoryError: (id, historyError) =>
    set((state) => {
      const entry = state.conversations[id]
      if (!entry) return state
      return {
        conversations: { ...state.conversations, [id]: { ...entry, historyError } },
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
