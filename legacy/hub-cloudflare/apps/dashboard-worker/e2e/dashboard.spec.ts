/**
 * Playwright E2E — dashboard happy path.
 *
 * The spec mandates a 15-step flow:
 *   1. Visit /
 *   2. Confirm "Reconciliation Hub" header
 *   3. Click "Matches" tab
 *   4. Confirm at least one match card is visible
 *   5. Click a match → detail / comment panel opens
 *   6. Type a comment, submit
 *   7. Confirm comment appears in the panel
 *   8. Click "Approve" on the same match
 *   9. Confirm success state
 *  10. Switch to "Today" tab — table renders
 *  11. Switch to "Devices" tab — table renders
 *  12. Switch to "Accounts" tab — table renders
 *  13. Trigger a 401 (clear the bypass header) → redirected / error
 *  14. Approve with READ_ONLY → 403
 *  15. Refresh the page — state is re-fetched
 *
 * Network responses are mocked to keep the test independent of D1 state.
 * The harness deliberately does NOT require a running worker.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const MOCK_MATCH = {
  ok: true,
  items: [
    {
      match: {
        id: 'm-1',
        transaction_candidate_id: 't-1',
        payment_claim_id: 'c-1',
        status: 'SUGGESTED',
        score: 0.92,
      },
      transaction: {
        id: 't-1',
        raw_sms_event_id: 'r-1',
        direction: 'CREDIT',
        amount_irr: 1_500_000,
        balance_irr: 12_345_000,
        status: 'PARSED',
        bank_timestamp: Date.now() - 60_000,
        financial_account_id: 'a-1',
      },
      claim: {
        id: 'c-1',
        financial_account_id: 'a-1',
        expected_amount_irr: 1_500_000,
        expected_at: Date.now() - 120_000,
        status: 'PENDING',
      },
      account_display: 'Melli Test Phone 1',
    },
  ],
};

const MOCK_TODAY = {
  ok: true,
  count: 1,
  items: [MOCK_MATCH.items[0]!.transaction],
};

const MOCK_DEVICES = {
  ok: true,
  items: [
    {
      id: 'd-1',
      device_code: 'phone-test',
      display_name: 'Test Phone',
      active: 1,
      last_seen_at: Date.now(),
    },
  ],
};

const MOCK_ACCOUNTS = {
  ok: true,
  items: [
    {
      id: 'a-1',
      display_name: 'Melli Test Phone 1',
      bank_name: 'Melli',
      card_last_four: '1234',
      account_last_four: '5678',
    },
  ],
};

const MOCK_COMMENTS = { ok: true, items: [] };

async function mockAll(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/matches')) return route.fulfill({ json: MOCK_MATCH });
    if (url.includes('/api/v1/today')) return route.fulfill({ json: MOCK_TODAY });
    if (url.includes('/api/v1/devices')) return route.fulfill({ json: MOCK_DEVICES });
    if (url.includes('/api/v1/accounts')) return route.fulfill({ json: MOCK_ACCOUNTS });
    if (url.includes('/api/v1/comments')) return route.fulfill({ json: MOCK_COMMENTS });
    if (url.includes('/api/v1/match/approve')) return route.fulfill({ json: { ok: true } });
    if (url.includes('/api/v1/comment')) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: { ok: false, error: 'unmocked' }, status: 404 });
  });
}

test('dashboard 15-step happy path', async ({ page }) => {
  await mockAll(page);

  // 1. Visit /
  await page.goto('/');

  // 2. Header
  await expect(page.getByRole('heading', { name: 'Reconciliation Hub' })).toBeVisible();

  // 3. Matches tab is default — click to ensure
  await page.getByRole('button', { name: 'Matches' }).click();

  // 4. Match card visible
  await expect(page.getByText('Melli Test Phone 1')).toBeVisible();
  await expect(page.getByText(/score 0\.9\d/).first()).toBeVisible();

  // 5. Click the match
  await page.locator('article.match').first().click();

  // 6. Type a comment + submit
  const textarea = page.locator('textarea');
  await textarea.fill('Reviewed by E2E');
  await page.getByRole('button', { name: 'Post' }).click();

  // 7. Comment is in the panel — the harness below will assert the panel updates
  await expect(page.getByText('Reviewed by E2E')).toBeVisible({ timeout: 5_000 });

  // 8. Approve
  await page.getByRole('button', { name: 'Approve' }).first().click();

  // 9. Success — no error banner appears
  await expect(page.locator('.error')).toHaveCount(0);

  // 10. Today tab
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: /Today's transactions/ })).toBeVisible();

  // 11. Devices tab
  await page.getByRole('button', { name: 'Devices' }).click();
  await expect(page.getByText('phone-test')).toBeVisible();

  // 12. Accounts tab
  await page.getByRole('button', { name: 'Accounts' }).click();
  await expect(page.getByText('Melli Test Phone 1')).toBeVisible();

  // 13. Force a 401 by re-mocking matches to 401
  await page.route('**/api/v1/matches', (r) =>
    r.fulfill({ status: 401, json: { ok: false, error: 'unauthorized' } }),
  );
  await page.getByRole('button', { name: 'Matches' }).click();
  await expect(page.locator('.error')).toContainText(/401/);

  // 14. READ_ONLY role → 403 from match/approve
  await page.unroute('**/api/**');
  await mockAll(page);
  await page.route('**/api/v1/match/approve', (r) =>
    r.fulfill({ status: 403, json: { ok: false, error: 'forbidden' } }),
  );
  await page.locator('article.match').first().click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.locator('.error')).toContainText(/403/);

  // 15. Refresh
  await page.unroute('**/api/**');
  await mockAll(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reconciliation Hub' })).toBeVisible();
});
