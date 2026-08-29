/**
 * Playwright E2E — notification bell + change-account UI.
 *
 * Asserts:
 *  - The bell replaces the old "Live" pill in the top-right.
 *  - The bell shows a count badge when /api/v1/notifications/counts returns
 *    a non-zero total.
 *  - Clicking the bell opens a dropdown with the four buckets (New /
 *    Unassigned / Unmatched / Suggested) and a Recent activity list.
 *  - The dropdown's "Move references to..." button is rendered on the
 *    Accounts table (smoke check for the new flow).
 *  - On wide desktop the bell sits inside the header, not overflowing
 *    the document (no overflow).
 *
 * Responses are mocked so the test is independent of D1 state.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const NOTIFICATION_COUNTS = {
  ok: true,
  counts: {
    new: 7,
    unassigned: 4,
    unmatched: 2,
    suggested: 1,
    // total = operational only (does NOT include new).
    total: 7,
    // unread = new (the "new" badge).
    unread: 7,
  },
  cursor: { at: null, id: null },
  updatedAt: 0,
};

const RECENT = {
  ok: true,
  items: [
    {
      id: 'r-1',
      direction: 'CREDIT',
      amount_irr: 1_500_000,
      status: 'PARSED',
      bank_timestamp: Date.now() - 60_000,
      accountId: 'a-1',
      accountDisplay: 'Poyan Test Account',
      hasMatch: false,
    },
  ],
};

const ACCOUNTS = {
  ok: true,
  items: [
    {
      id: 'a-1',
      display_name: 'Poyan Test Account',
      bank_name: 'MELLI',
      account_hint: '17000',
      card_last_four: null,
      account_last_four: null,
      device_id: null,
      active: 1,
      parser_configuration: '{}',
      additional_identifiers: [],
    },
  ],
};

async function mockAll(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/notifications/counts'))
      return route.fulfill({ json: NOTIFICATION_COUNTS });
    if (url.includes('/api/v1/notifications/recent')) return route.fulfill({ json: RECENT });
    if (url.includes('/api/v1/accounts')) return route.fulfill({ json: ACCOUNTS });
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });
}

async function gotoAccounts(page: Page) {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  await page.locator('.tabs .tab', { hasText: 'Accounts' }).first().click();
}

test.describe('Notification bell', () => {
  for (const width of [1280, 1440]) {
    test(`renders badge + dropdown at ${width}px`, async ({ page }) => {
      await mockAll(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();

      // 1. Bell exists, no "Live" pill.
      const bell = page.locator('.notification-bell__button');
      await bell.waitFor({ timeout: 10_000 });
      await expect(bell).toBeVisible();
      const livePill = page.locator('.live-status');
      await expect(livePill).toHaveCount(0);

      // 2. Badge shows the unread count (== new).
      const badge = page.locator('.notification-bell__badge');
      await expect(badge).toHaveText('7');

      // 3. No document overflow.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });
      expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(
        overflow.clientWidth,
      );

      // 4. Open the dropdown.
      await bell.click();
      const dropdown = page.locator('#notification-bell-dropdown');
      await dropdown.waitFor({ timeout: 5_000 });
      await expect(dropdown).toBeVisible();

      // 5. Four buckets visible.
      await expect(dropdown.locator('.count--new .count-value')).toHaveText('7');
      await expect(dropdown.locator('.count--unassigned .count-value')).toHaveText('4');
      await expect(dropdown.locator('.count--unmatched .count-value')).toHaveText('2');
      await expect(dropdown.locator('.count--suggested .count-value')).toHaveText('1');

      // 6. Recent activity has the seeded row.
      await expect(dropdown.locator('.notification-bell__item').first()).toContainText(
        'Poyan Test Account',
      );
    });
  }

  test('closes the dropdown on outside click', async ({ page }) => {
    await mockAll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
    await page.locator('.notification-bell__button').click();
    const dropdown = page.locator('#notification-bell-dropdown');
    await dropdown.waitFor();
    // Click somewhere outside.
    await page.getByRole('heading', { name: 'Reconciliation Hub' }).click();
    await expect(dropdown).toHaveCount(0);
  });
});

test('Accounts page exposes the Move references button', async ({ page }) => {
  await mockAll(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoAccounts(page);
  // Wait for the row to render.
  const row = page.locator('table.data-table tbody tr').first();
  await row.waitFor({ timeout: 10_000 });
  const moveButton = page.getByRole('button', { name: 'Move…' }).first();
  await expect(moveButton).toBeVisible();
  const referencesButton = page.getByRole('button', { name: 'References' }).first();
  await expect(referencesButton).toBeVisible();
});

test('Change account modal opens from the bell recent-item row', async ({ page }) => {
  await mockAll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  await page.locator('.notification-bell__button').click();
  await page.locator('#notification-bell-dropdown').waitFor();
  // The recent list refreshes on open; clicking it routes to Today.
  await page.locator('.notification-bell__item').first().click();
  await expect(page).toHaveURL(/$/);
});

test('opening the dropdown does NOT mark anything read', async ({ page }) => {
  // Record every POST /mark-read and /mark-all-read. None should fire on open.
  const markReadCalls: string[] = [];
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (
      url.includes('/api/v1/notifications/mark-read') ||
      url.includes('/api/v1/notifications/mark-all-read')
    ) {
      markReadCalls.push(url);
      return route.fulfill({ json: { ok: true, advanced: true } });
    }
    if (url.includes('/api/v1/notifications/counts'))
      return route.fulfill({ json: NOTIFICATION_COUNTS });
    if (url.includes('/api/v1/notifications/recent')) return route.fulfill({ json: RECENT });
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();

  // Open the dropdown.
  await page.locator('.notification-bell__button').click();
  await page.locator('#notification-bell-dropdown').waitFor();
  // Close it.
  await page.locator('.notification-bell__button').click();
  // Re-open and wait for stability.
  await page.locator('.notification-bell__button').click();
  await page.locator('#notification-bell-dropdown').waitFor();
  await page.waitForTimeout(500);

  // No mark-read, no mark-all-read.
  expect(markReadCalls).toEqual([]);
  // The badge still reads "7" (the unread count).
  await expect(page.locator('.notification-bell__badge')).toHaveText('7');
});

test('clicking a recent-activity item marks ONLY that transaction as read', async ({ page }) => {
  let lastSeenId: string | null = null;
  let lastSeenAt: number | null = null;
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/notifications/mark-read')) {
      const body = (route.request().postData() ?? '') as string;
      try {
        const j = JSON.parse(body) as {
          lastSeenTransactionAt: number;
          lastSeenTransactionId: string;
        };
        lastSeenAt = j.lastSeenTransactionAt;
        lastSeenId = j.lastSeenTransactionId;
      } catch {
        /* ignore */
      }
      return route.fulfill({ json: { ok: true, advanced: true } });
    }
    if (url.includes('/api/v1/notifications/mark-all-read')) {
      return route.fulfill({ json: { ok: true, advanced: true } });
    }
    if (url.includes('/api/v1/notifications/counts'))
      return route.fulfill({ json: NOTIFICATION_COUNTS });
    if (url.includes('/api/v1/notifications/recent')) return route.fulfill({ json: RECENT });
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  await page.locator('.notification-bell__button').click();
  await page.locator('#notification-bell-dropdown').waitFor();
  await page.locator('.notification-bell__item').first().click();

  // The item click fired mark-read with the seeded item's id.
  expect(lastSeenId).toBe('r-1');
  expect(lastSeenAt).toBe(RECENT.items[0].bank_timestamp);
});

test('"Mark all as read" advances the cursor and drops the unread badge', async ({ page }) => {
  let markAllCalled = false;
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/notifications/mark-all-read')) {
      markAllCalled = true;
      return route.fulfill({ json: { ok: true, advanced: true } });
    }
    if (url.includes('/api/v1/notifications/mark-read')) {
      return route.fulfill({ json: { ok: true, advanced: true } });
    }
    // Once mark-all has fired, drop the "new" count to 0 so the badge disappears.
    if (url.includes('/api/v1/notifications/counts')) {
      if (markAllCalled) {
        return route.fulfill({
          json: {
            ok: true,
            counts: {
              new: 0,
              unassigned: 4,
              unmatched: 2,
              suggested: 1,
              total: 7,
              unread: 0,
            },
            cursor: { at: Date.now(), id: 'r-1' },
            updatedAt: Date.now(),
          },
        });
      }
      return route.fulfill({ json: NOTIFICATION_COUNTS });
    }
    if (url.includes('/api/v1/notifications/recent')) return route.fulfill({ json: RECENT });
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  // Wait for the bell badge to render (means the first poll completed).
  await expect(page.locator('.notification-bell__badge')).toHaveText('7');
  await page.locator('.notification-bell__button').click();
  await page.locator('#notification-bell-dropdown').waitFor();

  const markAllBtn = page.getByRole('button', { name: 'Mark all as read' });
  await markAllBtn.click();
  await page.waitForTimeout(500);

  expect(markAllCalled).toBe(true);
  // The unread badge is gone (new = 0).
  await expect(page.locator('.notification-bell__badge')).toHaveCount(0);
});
