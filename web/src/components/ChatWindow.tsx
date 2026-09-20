import { useId, useState, type Ref } from 'react'
import { supabase } from '../lib/supabase'
import { announce } from '../store/announcerStore'
import type { ConnectionStatus } from '../store/conversationStore'
import type { Message, SenderType } from '../types'

interface ChatWindowProps {
  /** null until a conversation exists (the widget creates one lazily). */
  conversationId: string | null
  /** Called on send when there's no conversation yet; resolves to its id. */
  onEnsureConversation?: () => Promise<string>
  role: SenderType
  /** Who the other party is, for assistive tech: a customer's name, or "support". */
  counterpart: string
  /** Lets the parent move keyboard focus into the message box. */
  inputRef?: Ref<HTMLInputElement>
  /** Escape pressed in the message box (e.g. to return to the conversation list). */
  onEscape?: () => void
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
  counterpart,
  inputRef,
  onEscape,
  messages,
  messagesLoading,
  connectionStatus,
  draft,
  onDraftChange,
}: ChatWindowProps) {
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const inputId = useId()

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
    } else {
      // Focus stays in the box and the transcript is not a live region, so
      // without this a screen-reader user gets no sign the message went.
      announce('Message sent')
    }
  }

  return (
    <div className="flex h-full flex-col">
      {connectionStatus === 'error' && (
        <p role="status" className="bg-red-50 px-4 py-2 text-xs text-red-700">
          Couldn't connect to live updates. Messages may be delayed — try
          refreshing.
        </p>
      )}

      {/* role="log" gives assistive tech a navigable transcript. aria-live is
          off on purpose: new messages are announced (batched) by the page's
          single live region instead, so they aren't read twice or one by one.
          tabIndex makes the scrollable transcript reachable by keyboard. */}
      <div
        role="log"
        aria-live="off"
        aria-label={`Conversation with ${counterpart}`}
        aria-busy={messagesLoading}
        tabIndex={0}
        className="flex-1 space-y-2 overflow-y-auto p-4"
      >
        {messagesLoading ? (
          <p role="status" className="text-sm text-slate-600">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-600">
            No messages yet — say hello.
          </p>
        ) : (
          messages.map((message) => {
            const mine = message.sender_type === role
            return (
              <div
                key={message.id}
                className={`flex ${message.sender_type === 'agent' ? 'justify-end' : 'justify-start'}`}
              >
                <p
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                    message.sender_type === 'agent'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-900'
                  }`}
                >
                  <span className="sr-only">{mine ? 'You: ' : `${counterpart}: `}</span>
                  {message.body}
                </p>
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-slate-200 p-3">
        {sendError && (
          <p role="alert" className="mb-2 text-xs text-red-700">
            {sendError}
          </p>
        )}
        <form
          aria-label="Send a message"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            sendMessage()
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {role === 'agent' ? `Reply to ${counterpart}` : `Message ${counterpart}`}
          </label>
          <input
            id={inputId}
            ref={inputRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onEscape?.()
            }}
            placeholder="Type a message…"
            autoComplete="off"
            className="flex-1 rounded-lg border border-slate-500 px-3 py-2 text-sm"
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
