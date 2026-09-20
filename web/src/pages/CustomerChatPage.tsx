import { useState } from 'react'
import { ChatWindow } from '../components/ChatWindow'
import { LiveRegion } from '../components/LiveRegion'
import { useConversationChannel } from '../hooks/useConversationChannel'
import { useCustomerConversation } from '../hooks/useCustomerConversation'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useSupportReplyAnnouncements } from '../hooks/useSupportReplyAnnouncements'
import { useConversationStore } from '../store/conversationStore'

export function CustomerChatPage() {
  const { loading, error, retry } = useCustomerConversation()
  const conversationId = useConversationStore((s) => s.conversationId)
  const messages = useConversationStore((s) => s.messages)
  const messagesLoading = useConversationStore((s) => s.messagesLoading)
  const connectionStatus = useConversationStore((s) => s.connectionStatus)
  const addMessage = useConversationStore((s) => s.addMessage)
  const { retryHistory } = useConversationChannel(conversationId)
  const historyError = useConversationStore((s) => s.historyError)
  useSupportReplyAnnouncements(conversationId, messages, messagesLoading)
  useDocumentTitle('Chat with us — Frontdesk')
  const [draft, setDraft] = useState('')

  return (
    <div className="mx-auto flex h-screen max-w-md flex-col border-x border-slate-200">
      <header className="border-b border-slate-200 px-4 py-3">
        <h1 className="text-sm font-semibold text-slate-900">
          Chat with us
        </h1>
        <p className="text-xs text-slate-600">
          <a href="/agent" className="underline">
            Open agent console
          </a>{' '}
          to see this synced live.
        </p>
      </header>

      <main className="min-h-0 flex-1">
        {loading ? (
          <p role="status" className="p-4 text-sm text-slate-600">Connecting…</p>
        ) : error ? (
          <div role="alert" className="p-4 text-sm text-red-700">
            <p>Couldn't start a conversation: {error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-2 rounded-md bg-indigo-700 px-3 py-1 text-xs font-medium text-white"
            >
              Try again
            </button>
          </div>
        ) : conversationId ? (
          <ChatWindow
            conversationId={conversationId}
            role="customer"
            counterpart="support"
            messages={messages}
            onSent={addMessage}
            messagesLoading={messagesLoading}
            historyError={historyError}
            onRetryHistory={retryHistory}
            connectionStatus={connectionStatus}
            draft={draft}
            onDraftChange={setDraft}
          />
        ) : null}
      </main>
      <LiveRegion />
    </div>
  )
}
