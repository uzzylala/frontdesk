import { useState } from 'react'
import { ChatWindow } from '../components/ChatWindow'
import { useConversationChannel } from '../hooks/useConversationChannel'
import { useCustomerConversation } from '../hooks/useCustomerConversation'
import { useConversationStore } from '../store/conversationStore'

export function CustomerChatPage() {
  const { loading, error } = useCustomerConversation()
  const conversationId = useConversationStore((s) => s.conversationId)
  const messages = useConversationStore((s) => s.messages)
  const messagesLoading = useConversationStore((s) => s.messagesLoading)
  const connectionStatus = useConversationStore((s) => s.connectionStatus)
  useConversationChannel(conversationId)
  const [draft, setDraft] = useState('')

  return (
    <div className="mx-auto flex h-screen max-w-md flex-col border-x border-slate-200">
      <header className="border-b border-slate-200 px-4 py-3">
        <h1 className="text-sm font-semibold text-slate-900">
          Chat with us
        </h1>
        <p className="text-xs text-slate-400">
          <a href="/agent" className="underline">
            Open agent console
          </a>{' '}
          to see this synced live.
        </p>
      </header>

      <main className="min-h-0 flex-1">
        {loading ? (
          <p className="p-4 text-sm text-slate-400">Connecting…</p>
        ) : error ? (
          <p className="p-4 text-sm text-red-600">
            Couldn't start a conversation: {error}
          </p>
        ) : conversationId ? (
          <ChatWindow
            conversationId={conversationId}
            role="customer"
            messages={messages}
            messagesLoading={messagesLoading}
            connectionStatus={connectionStatus}
            draft={draft}
            onDraftChange={setDraft}
          />
        ) : null}
      </main>
    </div>
  )
}
