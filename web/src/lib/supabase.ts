import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.warn(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy web/.env.example to web/.env.local and fill in your Supabase project credentials.',
  )
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  realtime: {
    // Realtime keeps its socket alive with a main-thread timer, which Chrome
    // throttles in background tabs until the server drops the connection —
    // and with it this agent's Presence. `worker: true` moves that timer into
    // a Web Worker. Off for the embeddable widget: it runs on a third-party
    // page whose Content-Security-Policy may forbid blob workers, and
    // supabase-js disconnects outright if its worker errors.
    worker: __REALTIME_WORKER__,
  },
})
