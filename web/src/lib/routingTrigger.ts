/**
 * Who tells the server "a conversation was created / an agent went online".
 *
 * Production: a Supabase Database Webhook (supabase/webhooks.sql), which fires
 * no matter what wrote the row, so the browser stays out of it.
 *
 * Local development: Supabase can't call localhost, so the browser calls the
 * same endpoints itself. That's a dev-only stand-in, and it's opt-in
 * (VITE_ROUTING_TRIGGER=client, set in .env.development) so that a production
 * build can't quietly lean on it and hide a broken webhook.
 */
export const CLIENT_TRIGGERS_ROUTING = import.meta.env.VITE_ROUTING_TRIGGER === 'client'
