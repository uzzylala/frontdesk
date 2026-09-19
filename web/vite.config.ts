import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // web/api/*.ts served locally by devserver.ts (see its header comment
    // for why — no deployment exists yet for a real Database Webhook to
    // call).
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
