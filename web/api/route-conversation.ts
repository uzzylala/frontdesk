import { handleCors, targetId, type Req, type Res } from '../server/http.js'
import { assignNewConversation } from '../server/routing.js'
import { createAdminClient } from '../server/supabaseAdmin.js'

/**
 * Vercel handler — thin adapter over server/routing.ts. In production this
 * is called by a Supabase Database Webhook on `insert into conversations`
 * (see supabase/webhooks.sql), which fires whatever created the row. In local
 * development, where Supabase can't reach localhost, the customer page and the
 * widget call it directly instead (VITE_ROUTING_TRIGGER=client). Accepts both
 * body shapes — see targetId().
 */
export default async function handler(req: Req, res: Res) {
  if (handleCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const conversationId = targetId(req.body, 'conversationId', 'conversations')
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required' })
    return
  }

  try {
    const admin = createAdminClient()
    const result = await assignNewConversation(admin, conversationId)
    res.status(200).json(result)
  } catch (err) {
    console.error('route-conversation failed', err)
    res.status(500).json({ error: 'Routing failed' })
  }
}
