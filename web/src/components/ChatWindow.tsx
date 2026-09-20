import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { supabase } from '../lib/supabase'
import { announce } from '../store/announcerStore'
import type { ConnectionStatus } from '../store/conversationStore'
import type { Message, SenderType } from '../types'

/** Within this many px of the bottom still counts as "reading the newest message". */
const STICK_TO_BOTTOM_PX = 80

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
  /**
   * Called with the saved row as soon as the insert returns, so the sender sees
   * their message without waiting for the Realtime echo. Merged by id, so the
   * echo arriving too is harmless.
   */
  onSent?: (message: Message) => void
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
  onSent,
  messagesLoading,
  connectionStatus,
  draft,
  onDraftChange,
}: ChatWindowProps) {
  const [sending, setSending] = useState(false)
  // The message in flight, shown at once (dimmed) so the visitor never sees
  // an empty transcript between pressing Send and the row coming back.
  const [pending, setPending] = useState<{ body: string; seenIds: Set<string> } | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const inputId = useId()

  // Follow the conversation, but never fight a reader. `pinned` is "the reader
  // is at the newest message"; new content only scrolls the view while it is
  // true, so someone scrolled up through history isn't yanked away mid-read.
  const logRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lastTop = useRef(0)

  function onLogScroll() {
    const el = logRef.current
    // A hidden panel (the console keeps inactive conversations at display:none)
    // reports zero sizes and must not be mistaken for the reader scrolling up.
    if (!el || el.clientHeight === 0) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX
    lastTop.current = el.scrollTop
  }

  // A panel that was hidden when messages arrived can't scroll then (it has no
  // layout), and browsers may reset its position. When it becomes visible
  // again, go to the newest message — or back to where the reader was.
  useEffect(() => {
    const el = logRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === 0) return
      el.scrollTop = pinned.current ? el.scrollHeight : lastTop.current
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  async function sendMessage() {
    const body = draft.trim()
    if (!body || sending) return

    // Sending is an explicit "take me to the bottom", even from mid-history.
    pinned.current = true
    setSending(true)
    setSendError(null)
    setPending({ body, seenIds: new Set(messages.map((m) => m.id)) })
    onDraftChange('')

    let error: unknown = null
    try {
      const id = conversationId ?? (await onEnsureConversation?.())
      if (!id) throw new Error('No conversation to send to')
      const result = await supabase
        .from('messages')
        .insert({ conversation_id: id, sender_type: role, body })
        .select()
        .single()
      error = result.error
      if (result.data) onSent?.(result.data as Message)
    } catch (err) {
      error = err
    }
    setSending(false)
    setPending(null)

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

  // Hide the pending copy once its saved twin is in the list (the Realtime echo
  // can beat the insert's own response), so it is never drawn twice.
  const showPending =
    pending !== null &&
    !messages.some(
      (m) => !pending.seenIds.has(m.id) && m.sender_type === role && m.body === pending.body,
    )

  // Layout effect, not a plain one: scroll before paint so the newest message
  // never flashes in below the fold and then jumps.
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, showPending, messagesLoading])

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
        ref={logRef}
        onScroll={onLogScroll}
        role="log"
        aria-live="off"
        aria-label={`Conversation with ${counterpart}`}
        aria-busy={messagesLoading}
        tabIndex={0}
        className="flex-1 space-y-2 overflow-y-auto p-4"
      >
        {messagesLoading ? (
          <p role="status" className="text-sm text-slate-600">Loading conversation…</p>
        ) : messages.length === 0 && !showPending ? (
          <p className="text-sm text-slate-600">
            No messages yet — say hello.
          </p>
        ) : (
          <>
            {messages.map((message) => {
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
            })}
            {showPending && pending && (
              <div className={`flex ${role === 'agent' ? 'justify-end' : 'justify-start'}`}>
                <p
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm opacity-60 ${
                    role === 'agent' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-900'
                  }`}
                >
                  <span className="sr-only">You (sending): </span>
                  {pending.body}
                </p>
              </div>
            )}
          </>
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
