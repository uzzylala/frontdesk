import { useEffect, useState } from 'react'
import { ChatWindow } from '../components/ChatWindow'
import { ConversationSidebar } from '../components/ConversationSidebar'
import { useConsoleChannels } from '../hooks/useConsoleChannels'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'

export function AgentConsolePage() {
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const order = useConsoleStore((s) => s.order)
  const conversations = useConsoleStore((s) => s.conversations)
  const activeId = useConsoleStore((s) => s.activeConversationId)
  const initConversations = useConsoleStore((s) => s.initConversations)
  const setActiveConversation = useConsoleStore((s) => s.setActiveConversation)
  const setDraft = useConsoleStore((s) => s.setDraft)

  useEffect(() => {
    let cancelled = false

    supabase
      .from('conversations')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setListError(error.message)
          setListLoading(false)
          return
        }
        const list = data.map((c) => ({ id: c.id, customerName: c.customer_name }))
        initConversations(list)
        if (list.length > 0) setActiveConversation(list[0].id)
        setListLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Runs once on mount — the list of conversations to track for this
    // phase is fetched once; live arrival of brand-new conversations comes
    // with the routing/queue phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useConsoleChannels(order)

  return (
    <div className="flex h-screen">
      <div className="flex w-full max-w-5xl flex-col border-x border-slate-200 md:flex-row">
        {listLoading ? (
          <p className="p-4 text-sm text-slate-400">Loading conversations…</p>
        ) : listError ? (
          <p className="p-4 text-sm text-red-600">
            Couldn't load conversations: {listError}
          </p>
        ) : order.length === 0 ? (
          <div className="p-4">
            <h1 className="mb-1 text-sm font-semibold text-slate-900">
              Agent console
            </h1>
            <p className="text-sm text-slate-400">
              No active conversations yet. Waiting for a customer to say
              hello.
            </p>
          </div>
        ) : (
          <>
            <ConversationSidebar
              order={order}
              conversations={conversations}
              activeId={activeId}
              onSelect={setActiveConversation}
            />
            <div className="relative min-h-0 flex-1">
              {order.map((id) => {
                const entry = conversations[id]
                if (!entry) return null
                return (
                  <div
                    key={id}
                    className={id === activeId ? 'h-full' : 'hidden'}
                  >
                    <ChatWindow
                      conversationId={id}
                      role="agent"
                      messages={entry.messages}
                      messagesLoading={entry.messagesLoading}
                      connectionStatus={entry.connectionStatus}
                      draft={entry.draft}
                      onDraftChange={(draft) => setDraft(id, draft)}
                    />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
