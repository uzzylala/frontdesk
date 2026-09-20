import { describeConversation } from '../lib/describeConversation'
import type { ConversationEntry } from '../store/consoleStore'

interface ConversationSidebarProps {
  agentNames: Record<string, string>
  order: string[]
  conversations: Record<string, ConversationEntry>
  activeId: string | null
  /** Activation (click, Enter or Space) — not mere focus. */
  onSelect: (id: string) => void
}

/**
 * A navigation landmark holding a real list. Tab walks the items in order;
 * Enter/Space opens one (and the console then moves focus to its message
 * box). Focus alone never changes the open conversation, so a keyboard user
 * can browse the list without side effects. The open one is marked with
 * aria-current.
 */
export function ConversationSidebar({
  agentNames,
  order,
  conversations,
  activeId,
  onSelect,
}: ConversationSidebarProps) {
  return (
    <nav aria-label="Conversations" className="w-64 shrink-0 overflow-y-auto border-r border-slate-200">
      <ul>
        {order.map((id) => {
          const entry = conversations[id]
          if (!entry) return null
          const lastMessage = entry.messages[entry.messages.length - 1]

          return (
            <li key={id}>
              <button
                type="button"
                data-conversation-id={id}
                aria-current={id === activeId ? 'true' : undefined}
                aria-label={describeConversation(entry, agentNames)}
                onClick={() => onSelect(id)}
                className={`block w-full border-b border-slate-100 px-3 py-2 text-left ${
                  id === activeId ? 'bg-indigo-50' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {entry.customerName}
                  </span>
                  {/* Visual badges only: the same facts are in the button's
                      accessible name (describeConversation), so hide these. */}
                  {entry.unreadCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-700 px-1.5 text-xs font-medium text-white"
                    >
                      {entry.unreadCount}
                    </span>
                  )}
                  {entry.connectionStatus === 'error' && (
                    <span
                      aria-hidden="true"
                      title="Connection issue"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-700 text-xs font-bold text-white"
                    >
                      !
                    </span>
                  )}
                </div>
                {entry.previousAgentId && (
                  <p data-transferred-from={entry.previousAgentId} className="truncate text-xs text-amber-800">
                    Transferred from {agentNames[entry.previousAgentId] ?? 'another agent'}
                  </p>
                )}
                <p className="truncate text-xs text-slate-600">
                  {entry.messagesLoading
                    ? 'Loading…'
                    : (lastMessage?.body ?? (entry.historyError ? "Couldn't load messages" : 'No messages yet'))}
                </p>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
