import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'
import type { SenderType } from '../types'

interface ChatWindowProps {
  role: SenderType
}

export function ChatWindow({ role }: ChatWindowProps) {
  const conversationId = useConversationStore((s) => s.conversationId)
  const messages = useConversationStore((s) => s.messages)
  const messagesLoading = useConversationStore((s) => s.messagesLoading)
  const connectionStatus = useConversationStore((s) => s.connectionStatus)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  async function sendMessage() {
    const body = draft.trim()
    if (!body || !conversationId || sending) return

    setSending(true)
    setSendError(null)
    setDraft('')
    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_type: role,
      body,
    })
    setSending(false)

    if (error) {
      console.error('Failed to send message', error)
      setSendError('Message failed to send. Try again.')
      setDraft(body)
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
            onChange={(e) => setDraft(e.target.value)}
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
