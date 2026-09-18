import { ChatWindow } from '../components/ChatWindow'
import { useActiveConversation } from '../hooks/useActiveConversation'
import { useConversationChannel } from '../hooks/useConversationChannel'
import { useConversationStore } from '../store/conversationStore'

export function AgentConsolePage() {
  const { loading, error } = useActiveConversation('agent')
  const conversationId = useConversationStore((s) => s.conversationId)
  useConversationChannel(conversationId)

  return (
    <div className="mx-auto flex h-screen max-w-md flex-col border-x border-slate-200">
      <header className="border-b border-slate-200 px-4 py-3">
        <h1 className="text-sm font-semibold text-slate-900">
          Agent console
        </h1>
        <p className="text-xs text-slate-400">
          <a href="/" className="underline">
            Open customer chat
          </a>{' '}
          in another window to send a message here.
        </p>
      </header>

      <main className="min-h-0 flex-1">
        {loading ? (
          <p className="p-4 text-sm text-slate-400">Loading…</p>
        ) : error ? (
          <p className="p-4 text-sm text-red-600">
            Couldn't load conversations: {error}
          </p>
        ) : conversationId ? (
          <ChatWindow role="agent" />
        ) : (
          <p className="p-4 text-sm text-slate-400">
            No active conversation yet. Waiting for a customer to say
            hello.
          </p>
        )}
      </main>
    </div>
  )
}
