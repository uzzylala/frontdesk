import type { ConversationEntry } from '../store/consoleStore'

interface ConversationSidebarProps {
  order: string[]
  conversations: Record<string, ConversationEntry>
  activeId: string | null
  onSelect: (id: string) => void
}

export function ConversationSidebar({
  order,
  conversations,
  activeId,
  onSelect,
}: ConversationSidebarProps) {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-slate-200">
      {order.map((id) => {
        const entry = conversations[id]
        if (!entry) return null
        const lastMessage = entry.messages[entry.messages.length - 1]

        return (
          <button
            key={id}
            type="button"
            data-conversation-id={id}
            onClick={() => onSelect(id)}
            className={`block w-full border-b border-slate-100 px-3 py-2 text-left ${
              id === activeId ? 'bg-indigo-50' : 'hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-slate-900">
                {entry.customerName}
              </span>
              {entry.unreadCount > 0 && (
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white">
                  {entry.unreadCount}
                </span>
              )}
              {entry.connectionStatus === 'error' && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                  title="Connection issue"
                />
              )}
            </div>
            <p className="truncate text-xs text-slate-400">
              {entry.messagesLoading
                ? 'Loading…'
                : (lastMessage?.body ?? 'No messages yet')}
            </p>
          </button>
        )
      })}
    </aside>
  )
}
