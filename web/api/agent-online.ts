import { pullQueueForAgent } from '../server/routing.js'
import { createAdminClient } from '../server/supabaseAdmin.js'

interface Req {
  method?: string
  body?: unknown
}
interface Res {
  status(code: number): Res
  json(body: unknown): void
}

/**
 * Vercel handler — thin adapter over server/routing.ts. In production this
 * is called by a Supabase Database Webhook on `update of status on agents`
 * (see supabase/webhooks.sql). Locally, the status-toggle UI calls this
 * endpoint directly right after updating the agent's status to 'online'.
 */
export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body ?? {}) as { agentId?: string }
  if (!body.agentId) {
    res.status(400).json({ error: 'agentId is required' })
    return
  }

  try {
    const admin = createAdminClient()
    const result = await pullQueueForAgent(admin, body.agentId)
    res.status(200).json(result)
  } catch (err) {
    console.error('agent-online failed', err)
    res.status(500).json({ error: 'Queue pull failed' })
  }
}
