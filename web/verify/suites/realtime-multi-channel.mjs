import { createClient } from '@supabase/supabase-js'

import { env } from '../lib.mjs'

const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

// One client managing many channels — this is exactly what useConsoleChannels
// does in the app (a single Map<conversationId, RealtimeChannel>).
const client = createClient(url, key)

async function main() {
  const { data: conversations, error } = await client
    .from('conversations')
    .select('id, customer_name')
    .eq('status', 'open')
    .neq('customer_name', 'Customer')
    .order('created_at', { ascending: true })

  if (error) throw error
  console.log(`Tracking ${conversations.length} conversations:`, conversations.map((c) => c.customer_name))

  // received[conversationId] = array of message bodies that channel actually fired for
  const received = new Map(conversations.map((c) => [c.id, []]))
  const channels = new Map()

  await Promise.all(
    conversations.map(
      (c) =>
        new Promise((resolve, reject) => {
          const channel = client
            .channel(`conversation:${c.id}`)
            .on(
              'postgres_changes',
              {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
                filter: `conversation_id=eq.${c.id}`,
              },
              (payload) => {
                // Record which channel fired AND what conversation_id the
                // payload actually carries — any mismatch here would mean
                // cross-talk.
                received.get(c.id).push({
                  firedOnChannelFor: c.id,
                  payloadConversationId: payload.new.conversation_id,
                  body: payload.new.body,
                })
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') resolve()
              else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status))
            })
          channels.set(c.id, channel)
        }),
    ),
  )

  console.log('All channels subscribed. Firing near-simultaneous inserts…')

  const stamp = Date.now()
  const expectedBody = new Map(conversations.map((c) => [c.id, `crosstalk-check-${stamp}-${c.customer_name}`]))

  // Fire all inserts concurrently to maximize any chance of cross-talk if
  // the subscription/dispatch logic were broken.
  await Promise.all(
    conversations.map((c) =>
      client.from('messages').insert({
        conversation_id: c.id,
        sender_type: 'agent',
        body: expectedBody.get(c.id),
      }),
    ),
  )

  await new Promise((r) => setTimeout(r, 3000))

  let allGood = true
  for (const c of conversations) {
    const events = received.get(c.id)
    const wrongConversation = events.filter((e) => e.payloadConversationId !== c.id)
    const gotOwnMessage = events.some((e) => e.body === expectedBody.get(c.id))
    const gotAnyoneElsesMessage = events.some((e) => e.body !== expectedBody.get(c.id))

    console.log(
      `${c.customer_name} (${c.id.slice(0, 8)}): received ${events.length} event(s), ` +
        `got own message: ${gotOwnMessage}, wrong conversation_id in payload: ${wrongConversation.length}, ` +
        `leaked another customer's message: ${gotAnyoneElsesMessage}`,
    )

    if (!gotOwnMessage || wrongConversation.length > 0 || gotAnyoneElsesMessage) {
      allGood = false
    }
  }

  for (const channel of channels.values()) await client.removeChannel(channel)

  console.log(allGood ? '\nRESULT: PASS — no cross-talk between any conversation.' : '\nRESULT: FAIL')
  process.exit(allGood ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED', err)
  process.exit(1)
})
