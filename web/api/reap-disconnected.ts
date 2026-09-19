import { handleCors, type Req, type Res } from '../server/http.js'
import { reapDisconnectedAgents } from '../server/routing.js'
import { createAdminClient } from '../server/supabaseAdmin.js'

/**
 * Reassigns conversations away from agents whose connection has dropped.
 * Called by every connected console: once when it sees a presence `leave`
 * (with an agentId), and on a timer as a backstop (without one).
 *
 * Safe for anyone to call, any number of times: the decision rests solely
 * on the durable heartbeat, and each move is a compare-and-set.
 */
export default async function handler(req: Req, res: Res) {
  if (handleCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body ?? {}) as { agentId?: string }

  try {
    const admin = createAdminClient()
    const results = await reapDisconnectedAgents(admin, body.agentId)
    res.status(200).json({ results })
  } catch (err) {
    console.error('reap-disconnected failed', err)
    res.status(500).json({ error: 'Reap failed' })
  }
}
