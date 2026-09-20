import { defineConfig } from '@playwright/test'

// The credentials the test's setup/cleanup need (service role, to reset agents and remove its own conversation).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* CI can provide them in the environment instead */
}

const APP = process.env.APP ?? 'http://localhost:5173'

export default defineConfig({
  testDir: 'e2e',
  // One flow, one worker: it drives shared state (agent presence, a single Supabase project), so it must not overlap
  // with itself, and it includes a ~15s heartbeat-staleness wait that no amount of parallelism shortens.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: APP, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // Starts the app + local functions unless one is already running (or APP points at a deployment).
  webServer: process.env.APP
    ? undefined
    : { command: 'npm run dev', url: APP, reuseExistingServer: true, timeout: 90_000 },
})
