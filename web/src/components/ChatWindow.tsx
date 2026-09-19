import { useState } from 'react'
import { supabase } from '../lib/supabase'
import type { ConnectionStatus } from '../store/conversationStore'
import type { Message, SenderType } from '../types'

interface ChatWindowProps {
  /** null until a conversation exists (the widget creates one lazily). */
  conversationId: string | null
  /** Called on send when there's no conversation yet; resolves to its id. */
  onEnsureConversation?: () => Promise<string>
  role: SenderType
  messages: Message[]
  messagesLoading: boolean
  connectionStatus: ConnectionStatus
  draft: string
  onDraftChange: (draft: string) => void
}

/**
 * Purely presentational: reads only what's passed in as props. Both the
 * single-conversation customer page and the multi-conversation agent
 * console render this — each wires it to its own store shape, so this
 * component doesn't need to know which one it's talking to.
 */
export function ChatWindow({
  conversationId,
  onEnsureConversation,
  role,
  messages,
  messagesLoading,
  connectionStatus,
  draft,
  onDraftChange,
}: ChatWindowProps) {
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  async function sendMessage() {
    const body = draft.trim()
    if (!body || sending) return

    setSending(true)
    setSendError(null)
    onDraftChange('')

    let error: unknown = null
    try {
      const id = conversationId ?? (await onEnsureConversation?.())
      if (!id) throw new Error('No conversation to send to')
      const result = await supabase.from('messages').insert({
        conversation_id: id,
        sender_type: role,
        body,
      })
      error = result.error
    } catch (err) {
      error = err
    }
    setSending(false)

    if (error) {
      console.error('Failed to send message', error)
      setSendError('Message failed to send. Try again.')
      onDraftChange(body)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {connectionStatus === 'error' && (
        <p className="bg-red-50 px-4 py-2 text-xs text-red-600">
          Couldn't connect to live updates. Messages may be delayed — try
          refreshing.
        </p>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messagesLoading ? (
          <p className="text-sm text-slate-400">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-400">
            No messages yet — say hello.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender_type === 'agent' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                  message.sender_type === 'agent'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-900'
                }`}
              >
                {message.body}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-200 p-3">
        {sendError && <p className="mb-2 text-xs text-red-600">{sendError}</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            sendMessage()
          }}
        >
          <input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
