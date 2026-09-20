import { createClient } from '@supabase/supabase-js'

import { env } from '../lib.mjs'

const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

// Two independent clients = two independent browser windows.
const customerClient = createClient(url, key)
const agentClient = createClient(url, key)

async function main() {
  // 1. Find or create the open conversation, same as the app does.
  let { data: convo } = await customerClient
    .from('conversations')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!convo) {
    const { data: created, error } = await customerClient
      .from('conversations')
      .insert({})
      .select()
      .single()
    if (error) throw error
    convo = created
  }

  console.log('Using conversation', convo.id)

  const received = { onAgentChannel: null, onCustomerChannel: null }

  // 2. Agent window subscribes to the conversation channel, exactly like
  //    useConversationChannel does.
  const agentChannel = agentClient
    .channel(`conversation:${convo.id}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${convo.id}`,
      },
      (payload) => {
        received.onAgentChannel = payload.new
      },
    )

  // 3. Customer window subscribes too (its own tab would show its own sent
  //    message arrive back via the same path).
  const customerChannel = customerClient
    .channel(`conversation:${convo.id}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${convo.id}`,
      },
      (payload) => {
        received.onCustomerChannel = payload.new
      },
    )

  await new Promise((resolve, reject) => {
    let pending = 2
    function done(status, label) {
      if (status === 'SUBSCRIBED') {
        pending -= 1
        if (pending === 0) resolve()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(new Error(`${label} channel failed: ${status}`))
      }
    }
    agentChannel.subscribe((status) => done(status, 'agent'))
    customerChannel.subscribe((status) => done(status, 'customer'))
  })

  console.log('Both channels subscribed.')

  // 4. Customer sends a message via insert (what the customer page's Send does).
  const customerBody = `customer-ping-${Date.now()}`
  const { error: insertError } = await customerClient.from('messages').insert({
    conversation_id: convo.id,
    sender_type: 'customer',
    body: customerBody,
  })
  if (insertError) throw insertError

  await new Promise((r) => setTimeout(r, 2500))

  console.log('Agent window received:', received.onAgentChannel?.body)
  console.log('Customer window received (own echo):', received.onCustomerChannel?.body)

  const agentGotIt = received.onAgentChannel?.body === customerBody
  const customerGotEcho = received.onCustomerChannel?.body === customerBody

  console.log('\nRESULT: agent received live customer message:', agentGotIt)
  console.log('RESULT: customer tab received its own message via realtime:', customerGotEcho)

  await agentClient.removeChannel(agentChannel)
  await customerClient.removeChannel(customerChannel)

  if (!agentGotIt) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('FAILED', err)
  process.exit(1)
})
