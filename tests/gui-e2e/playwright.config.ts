/**
 * Playwright Electron GUI e2e.
 * Expects a prior `pnpm build` (launches `out/main/index.js`).
 * Separate from Vitest `tests/main/e2e` (agent-pipeline mocks).
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  retries: 0
})
