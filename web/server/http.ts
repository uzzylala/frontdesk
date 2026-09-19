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
