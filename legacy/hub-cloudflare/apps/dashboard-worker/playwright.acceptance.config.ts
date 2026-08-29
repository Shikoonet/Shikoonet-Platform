/**
 * TEMPORARY — staging acceptance run. Points at the `wrangler dev --remote`
 * preview (same bundle as the deployed staging Worker, real payment-hub-staging
 * D1). No webServer: the preview is started manually.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-acceptance',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
