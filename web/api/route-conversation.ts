import { handleCors, type Req, type Res } from '../server/http.js'
import { assignNewConversation } from '../server/routing.js'
import { createAdminClient } from '../server/supabaseAdmin.js'

/**
 * Vercel handler — thin adapter over server/routing.ts. In production this
 * is called by a Supabase Database Webhook on `insert into conversations`,
 * which is the authoritative trigger (see supabase/webhooks.sql). Locally,
 * with nothing deployed yet, the customer page and the widget call this
 * endpoint directly right after inserting the conversation.
 */
export default async function handler(req: Req, res: Res) {
  if (handleCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body ?? {}) as { conversationId?: string }
  if (!body.conversationId) {
    res.status(400).json({ error: 'conversationId is required' })
    return
  }

  try {
    const admin = createAdminClient()
    const result = await assignNewConversation(admin, body.conversationId)
    res.status(200).json(result)
  } catch (err) {
    console.error('route-conversation failed', err)
    res.status(500).json({ error: 'Routing failed' })
  }
}
