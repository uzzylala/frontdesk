import { useState } from 'react'
import { ChatWindow } from '../components/ChatWindow'
import { LiveRegion } from '../components/LiveRegion'
import { useConversationChannel } from '../hooks/useConversationChannel'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useLazyConversation } from '../hooks/useLazyConversation'
import { useSupportReplyAnnouncements } from '../hooks/useSupportReplyAnnouncements'
import { CLIENT_TRIGGERS_ROUTING } from '../lib/routingTrigger'
import { useConversationStore } from '../store/conversationStore'

const STORAGE_KEY = 'frontdesk:customer-conversation-id'

export function CustomerChatPage() {
  // Nothing is created here on load: the conversation is created by the first message (see useLazyConversation).
  const { conversationId, ensureConversation, lookup, retryLookup } = useLazyConversation({
    storageKey: STORAGE_KEY,
    clientRouting: CLIENT_TRIGGERS_ROUTING,
  })
  const messages = useConversationStore((s) => s.messages)
  const messagesLoading = useConversationStore((s) => s.messagesLoading)
  const connectionStatus = useConversationStore((s) => s.connectionStatus)
  const addMessage = useConversationStore((s) => s.addMessage)
  const { retryHistory } = useConversationChannel(conversationId)
  const historyError = useConversationStore((s) => s.historyError)
  useSupportReplyAnnouncements(conversationId, messages, conversationId ? messagesLoading : false)
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
        {lookup === 'resolving' ? (
          <p role="status" className="p-4 text-sm text-slate-600">Connecting…</p>
        ) : lookup === 'failed' ? (
          <div role="alert" className="p-4 text-sm text-red-700">
            <p>Couldn't reach your conversation.</p>
            <button
              type="button"
              onClick={retryLookup}
              className="mt-2 rounded-md bg-indigo-700 px-3 py-1 text-xs font-medium text-white"
            >
              Try again
            </button>
          </div>
        ) : (
          <ChatWindow
            conversationId={conversationId}
            onEnsureConversation={ensureConversation}
            role="customer"
            counterpart="support"
            messages={messages}
            onSent={addMessage}
            messagesLoading={conversationId ? messagesLoading : false}
            historyError={conversationId ? historyError : false}
            onRetryHistory={retryHistory}
            connectionStatus={conversationId ? connectionStatus : 'subscribed'}
            draft={draft}
            onDraftChange={setDraft}
          />
        )}
      </main>
      <LiveRegion />
    </div>
  )
}
