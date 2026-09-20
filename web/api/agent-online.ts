import { handleCors, logCaller, targetId, type Req, type Res } from '../server/http.js'
import { pullQueueForAgent } from '../server/routing.js'
import { createAdminClient } from '../server/supabaseAdmin.js'

/**
 * Vercel handler — thin adapter over server/routing.ts. In production this
 * is called by a Supabase Database Webhook on `update of status on agents`
 * (see supabase/webhooks.sql). Locally, the console calls this endpoint
 * directly after an agent goes online or an online agent (re)connects.
 */
export default async function handler(req: Req, res: Res) {
  if (handleCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  logCaller('agent-online', req)

  const agentId = targetId(req.body, 'agentId', 'agents')
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' })
    return
  }

  try {
    const admin = createAdminClient()
    const result = await pullQueueForAgent(admin, agentId)
    res.status(200).json(result)
  } catch (err) {
    console.error('agent-online failed', err)
    res.status(500).json({ error: 'Queue pull failed' })
  }
}
