import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import agentOnlineHandler from './api/agent-online.js'
import reapDisconnectedHandler from './api/reap-disconnected.js'
import routeConversationHandler from './api/route-conversation.js'
import type { Req, Res } from './server/http.js'

/**
 * Serves web/api/*.ts locally during `npm run dev`, proxied to by Vite
 * (see server.proxy in vite.config.ts). This exists only because nothing
 * is deployed yet, so Supabase has no public URL to call for the real
 * Database Webhook trigger (see supabase/webhooks.sql) — this stands in
 * for that locally by calling the exact same handler modules that Vercel
 * would run in production, just over plain Node http instead of Vercel's
 * runtime.
 */
const PORT = 8787

type Handler = (req: Req, res: Res) => Promise<void>

const routes: Record<string, Handler> = {
  '/api/route-conversation': routeConversationHandler,
  '/api/agent-online': agentOnlineHandler,
  '/api/reap-disconnected': reapDisconnectedHandler,
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? ''
  const handler = routes[url]

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const adaptedRes: Res = {
    status(code: number) {
      res.statusCode = code
      return adaptedRes
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value)
    },
    json(payload: unknown) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(payload))
    },
  }

  try {
    await handler({ method: req.method, body, headers: req.headers }, adaptedRes)
  } catch (err) {
    console.error(`Unhandled error in ${url}`, err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal error' }))
  }
})

server.listen(PORT, () => {
  console.log(`[devserver] api functions listening on http://localhost:${PORT}`)
})
