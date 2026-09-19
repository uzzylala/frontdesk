import { createClient } from '@supabase/supabase-js'

/**
 * Service-role client — bypasses RLS entirely. This module must only ever
 * run server-side (Vercel functions in api/, or the local dev proxy in
 * devserver.ts). Nothing under src/ may import it: that's the browser
 * bundle, and this key must never reach it.
 */
export function createAdminClient() {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set them in web/.env.local.',
    )
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  })
}
