import { useState } from 'react'
import { ChatWindow } from '../components/ChatWindow'
import { useConversationChannel } from '../hooks/useConversationChannel'
import { useConversationStore } from '../store/conversationStore'
import { useWidgetConversation } from './useWidgetConversation'

interface WidgetProps {
  apiBase: string
  clientRouting?: boolean
  customerName?: string
}

export function Widget({ apiBase, customerName, clientRouting }: WidgetProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const { conversationId, ensureConversation } = useWidgetConversation({ apiBase, customerName, clientRouting })
  useConversationChannel(conversationId)

  const messages = useConversationStore((s) => s.messages)
  const messagesLoading = useConversationStore((s) => s.messagesLoading)
  const connectionStatus = useConversationStore((s) => s.connectionStatus)

  return (
    <div className="flex flex-col items-end gap-3">
      {open && (
        <div
          role="dialog"
          aria-label="Chat with support"
          className="flex h-[480px] w-[360px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between bg-indigo-600 px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Chat with us</p>
              <p className="text-xs text-indigo-100">We typically reply in a few minutes</p>
            </div>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-lg leading-none text-indigo-100 hover:bg-indigo-500"
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatWindow
              conversationId={conversationId}
              onEnsureConversation={ensureConversation}
              role="customer"
              messages={messages}
              messagesLoading={conversationId ? messagesLoading : false}
              connectionStatus={conversationId ? connectionStatus : 'subscribed'}
              draft={draft}
              onDraftChange={setDraft}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={open ? 'Close chat' : 'Open chat'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-500"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 21 12Z"
          />
        </svg>
      </button>
    </div>
  )
}
