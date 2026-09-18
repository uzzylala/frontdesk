import { useEffect, useState } from 'react'
import { ChatWindow } from './components/ChatWindow'
import { useConversationChannel } from './hooks/useConversationChannel'
import { supabase } from './lib/supabase'
import { useConversationStore } from './store/conversationStore'

const STORAGE_KEY = 'frontdesk:demo-conversation-id'

function App() {
  const conversationId = useConversationStore((s) => s.conversationId)
  const setConversationId = useConversationStore((s) => s.setConversationId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const existingId = localStorage.getItem(STORAGE_KEY)
    if (existingId) {
      setConversationId(existingId)
      return
    }

    supabase
      .from('conversations')
      .insert({})
      .select()
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          setError(error?.message ?? 'Failed to create conversation')
          return
        }
        localStorage.setItem(STORAGE_KEY, data.id)
        setConversationId(data.id)
      })
  }, [setConversationId])

  useConversationChannel(conversationId)

  return (
    <div className="mx-auto flex h-screen max-w-md flex-col border-x border-slate-200">
      <header className="border-b border-slate-200 px-4 py-3">
        <h1 className="text-sm font-semibold text-slate-900">
          Frontdesk — demo conversation
        </h1>
        <p className="text-xs text-slate-400">
          Open this page in two tabs to see Realtime sync.
        </p>
      </header>

      {error && (
        <p className="bg-red-50 px-4 py-2 text-xs text-red-600">{error}</p>
      )}

      <main className="min-h-0 flex-1">
        {conversationId ? (
          <ChatWindow />
        ) : (
          <p className="p-4 text-sm text-slate-400">
            {error ? 'Check your Supabase config.' : 'Connecting…'}
          </p>
        )}
      </main>
    </div>
  )
}

export default App
