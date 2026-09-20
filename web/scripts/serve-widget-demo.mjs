// Serves the demo host page and the built widget bundle on their own origin,
// deliberately separate from the Vite app — proving the widget needs nothing
// from the main React app. Usage: npm run widget:demo
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 5180)

const files = {
  '/': { path: join(root, 'widget-demo', 'index.html'), type: 'text/html; charset=utf-8' },
  '/widget.js': { path: join(root, 'dist', 'widget.js'), type: 'text/javascript; charset=utf-8' },
}

createServer(async (req, res) => {
  const entry = files[(req.url ?? '/').split('?')[0]]
  if (!entry) {
    res.writeHead(404).end('Not found')
    return
  }
  try {
    const body = await readFile(entry.path)
    // Compressed like any real host would: an uncompressed 450 KB widget.js makes the local numbers look far worse than
    // what a visitor is served (production sends ~130 KB gzip).
    const gzip = String(req.headers['accept-encoding'] ?? '').includes('gzip')
    res
      .writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store', ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) })
      .end(gzip ? gzipSync(body) : body)
  } catch {
    res.writeHead(500).end('Missing file — run `npm run build:widget` first.')
  }
}).listen(PORT, () => {
  console.log(`[widget-demo] host page on http://localhost:${PORT}`)
})
