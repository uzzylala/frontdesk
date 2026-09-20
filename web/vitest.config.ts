import { defineConfig } from 'vitest/config'

// Unit tests only. The Playwright E2E (e2e/) and the browser verification suites (verify/) have their own runners
// and need a live app + database, so they must not be picked up here.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
})
