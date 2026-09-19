/// <reference types="vite/client" />

/**
 * Build-time flag (see the `define` in vite.config.ts / vite.widget.config.ts):
 * run Supabase Realtime's socket keepalive in a Web Worker so it isn't
 * throttled in background tabs. On for the app, off for the embeddable widget.
 */
declare const __REALTIME_WORKER__: boolean
