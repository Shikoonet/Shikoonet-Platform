import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the DevicesView Add-Device modal.
 *
 * The full dashboard e2e suite needs both Vite (5173) and wrangler dev
 * (8787) running. Compatibility-date mismatches sometimes block wrangler
 * from starting in CI; this config runs only Vite and uses page.route()
 * to mock /api/* so the modal close flow can be exercised in a real
 * browser without the backend.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /modal-close\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // bypass Cloudflare Access checks (page will hit a mocked /api/* and
    // never reach the worker that enforces them).
    extraHTTPHeaders: { 'cf-access-bypass': 'e2e' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'cd ../dashboard-web && pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
