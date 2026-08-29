import { defineConfig, devices } from '@playwright/test';

/**
 * Mobile-overflow diagnostic config. Runs ONLY the dashboard-web Vite dev
 * server — every `/api/**` route is intercepted and mocked by the test, so
 * the dashboard-worker (and its wrangler/workerd runtime) is irrelevant.
 *
 * Run from the dashboard-worker dir (where @playwright/test lives):
 *   node_modules/.bin/playwright test --config=playwright.mobile.config.ts
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /mobile-unmatched-overflow\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'cd ../dashboard-web && node_modules/.bin/vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
