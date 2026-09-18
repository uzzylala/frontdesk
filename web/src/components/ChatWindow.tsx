import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useConversationStore } from '../store/conversationStore'
import type { SenderType } from '../types'

export function ChatWindow() {
  const conversationId = useConversationStore((s) => s.conversationId)
  const messages = useConversationStore((s) => s.messages)
  const [draft, setDraft] = useState('')
  const [sender, setSender] = useState<SenderType>('customer')
  const [sending, setSending] = useState(false)

  async function sendMessage() {
    const body = draft.trim()
    if (!body || !conversationId || sending) return

    setSending(true)
    setDraft('')
    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_type: sender,
      body,
    })
    setSending(false)

    if (error) {
      console.error('Failed to send message', error)
      setDraft(body)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            No messages yet — say hello.
          </p>
        )}
        {messages.map((message) => (
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
        ))}
      </div>

      <div className="border-t border-slate-200 p-3">
        <div className="mb-2 flex gap-1">
          {(['customer', 'agent'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSender(option)}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                sender === option
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
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
            placeholder={`Send as ${sender}…`}
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
