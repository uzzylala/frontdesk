import { AgentRoster } from '../components/AgentRoster'
import { AgentStatusToggle } from '../components/AgentStatusToggle'
import { ChatWindow } from '../components/ChatWindow'
import { ConversationSidebar } from '../components/ConversationSidebar'
import { QueueList } from '../components/QueueList'
import { useAgentPresence } from '../hooks/useAgentPresence'
import { useAgentRoster } from '../hooks/useAgentRoster'
import { useConsoleChannels } from '../hooks/useConsoleChannels'
import { useCurrentAgent } from '../hooks/useCurrentAgent'
import { supabase } from '../lib/supabase'
import { useConsoleStore } from '../store/consoleStore'

export function AgentConsolePage() {
  const { agents, currentAgent, loading, error, selectAgent, switchAgent, setStatus } =
    useCurrentAgent()

  if (loading) return <p className="p-4 text-sm text-slate-400">Loading…</p>
  if (error)
    return <p className="p-4 text-sm text-red-600">Couldn't load agents: {error}</p>

  if (!currentAgent) {
    return (
      <div className="mx-auto max-w-sm p-6">
        <h1 className="mb-1 text-sm font-semibold text-slate-900">
          Who are you?
        </h1>
        <p className="mb-4 text-xs text-slate-400">
          No login yet — pick an agent to continue.
        </p>
        <div className="space-y-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => selectAgent(agent.id)}
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
            >
              {agent.name}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <ConsoleBody
      agents={agents}
      currentAgent={currentAgent}
      switchAgent={switchAgent}
      setStatus={setStatus}
    />
  )
}

interface ConsoleBodyProps {
  agents: ReturnType<typeof useCurrentAgent>['agents']
  currentAgent: NonNullable<ReturnType<typeof useCurrentAgent>['currentAgent']>
  switchAgent: () => void
  setStatus: ReturnType<typeof useCurrentAgent>['setStatus']
}

function ConsoleBody({ agents, currentAgent, switchAgent, setStatus }: ConsoleBodyProps) {
  const { queue, loading, error, refetch } = useAgentRoster(currentAgent.id)
  const { connectedIds, channelStatus } = useAgentPresence(currentAgent, refetch)
  const agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]))

  const order = useConsoleStore((s) => s.order)
  const conversations = useConsoleStore((s) => s.conversations)
  const activeId = useConsoleStore((s) => s.activeConversationId)
  const setActiveConversation = useConsoleStore((s) => s.setActiveConversation)
  const setDraft = useConsoleStore((s) => s.setDraft)

  useConsoleChannels(order)

  async function pickUp(conversationId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('conversations')
      .update({ assigned_agent_id: currentAgent.id })
      .eq('id', conversationId)
      .is('assigned_agent_id', null)
      .select()

    if (error) {
      console.error('Failed to pick up conversation', error)
      return false
    }
    if (!data || data.length === 0) return false

    // Best-effort tie-break bookkeeping — not critical if this fails.
    supabase
      .from('agents')
      .update({ last_assigned_at: new Date().toISOString() })
      .eq('id', currentAgent.id)
      .then(() => {})

    return true
  }

  return (
    <div className="flex h-screen">
      <div className="flex w-full max-w-5xl flex-col border-x border-slate-200">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold text-slate-900">{currentAgent.name}</h1>
            <button
              type="button"
              onClick={switchAgent}
              className="text-xs text-slate-400 underline"
            >
              Switch agent
            </button>
          </div>
          <AgentStatusToggle status={currentAgent.status} onChange={setStatus} />
        </header>

        {channelStatus === 'disconnected' && (
          <p role="status" className="bg-red-50 px-4 py-2 text-xs text-red-700">
            Connection lost — reconnecting. Your conversations may be reassigned to
            another agent if this lasts more than a few seconds.
          </p>
        )}

        <AgentRoster agents={agents} connectedIds={connectedIds} selfId={currentAgent.id} />

        <QueueList queue={queue} agentNames={agentNames} onPickUp={pickUp} />

        <div className="flex min-h-0 flex-1 md:flex-row">
          {loading ? (
            <p className="p-4 text-sm text-slate-400">Loading conversations…</p>
          ) : error ? (
            <p className="p-4 text-sm text-red-600">
              Couldn't load conversations: {error}
            </p>
          ) : order.length === 0 ? (
            <p className="p-4 text-sm text-slate-400">
              No conversations assigned to you yet.
              {queue.length > 0 && ' Pick one up from the queue above, or go online to get routed the next one automatically.'}
            </p>
          ) : (
            <>
              <ConversationSidebar
                agentNames={agentNames}
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
                    <div key={id} className={id === activeId ? 'h-full' : 'hidden'}>
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
    </div>
  )
}
