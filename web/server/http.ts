export interface Req {
  method?: string
  body?: unknown
}

export interface Res {
  status(code: number): Res
  setHeader(name: string, value: string): void
  json(body: unknown): void
}

/**
 * The id of the row a handler was asked to act on. Two callers, two shapes:
 * a client calling directly sends `{ conversationId }` / `{ agentId }`; a
 * Database Webhook (pg_net, see supabase/webhooks.sql) sends the changed row
 * as `{ type, table, record: { id, ... } }`. Both resolve here, so the
 * handlers don't care who triggered them.
 */
export function targetId(body: unknown, directKey: string, table: string): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>
  const direct = b[directKey]
  if (typeof direct === 'string') return direct

  const record = b.record as { id?: unknown } | undefined
  if (b.table === table && typeof record?.id === 'string') return record.id
  return undefined
}

/**
 * The embeddable widget calls these endpoints from whatever third-party page
 * hosts it, so they must answer cross-origin requests. `*` is acceptable here
 * because the endpoints carry no cookies or credentials and are idempotent:
 * routing an already-routed conversation, or sweeping when nobody's stale,
 * is a no-op.
 *
 * Returns true if this was a preflight and has been fully answered.
 */
export function handleCors(req: Req, res: Res): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(200).json({})
    return true
  }
  return false
}
