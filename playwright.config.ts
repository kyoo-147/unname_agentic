import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'pnpm dev', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
    { command: 'node scripts/test-provider.mjs', url: 'http://127.0.0.1:4319/metrics', reuseExistingServer: !process.env.CI },
  ],
});
