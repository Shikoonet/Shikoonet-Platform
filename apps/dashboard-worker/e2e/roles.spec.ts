/**
 * What the narrowest role actually sees, asked of a browser.
 *
 * `write-roles.test.ts` and `read-roles.test.ts` ask the server. They are the
 * boundary and they are enough to keep data in — but they cannot see the panel.
 * Two claims live only in the browser:
 *
 *   1. The sidebar is filtered, so a reader is not offered a section that will
 *      answer 403. `nav.ts` states the reason ("a panel that offers a door and
 *      then refuses it reads as broken rather than as a boundary") and nothing
 *      measured it.
 *   2. The count in that claim. Two comments — `App.tsx` and `PasswordCard.tsx`
 *      — said "nine of twenty-three" until 2026-08-22, when it was counted for
 *      the first time and turned out to be fifteen. This file is why the number
 *      cannot drift again: it is read off the rendered sidebar, not off a list
 *      kept beside the one it describes.
 *
 * Signed in through the real front door on `LOGIN_PORT`, because the bypass
 * server names one address and that address is ADMIN.
 */

import { expect, test, type Page } from '@playwright/test';
import { READER_EMAIL, READER_PASSWORD } from './global-setup.js';

const BASE = 'http://127.0.0.1:8800';

test.use({ baseURL: BASE });

/**
 * Sections a READ_ONLY operator must not be offered, by the label a person
 * reads. Deliberately the Persian strings rather than the `PageId`s: an id that
 * is filtered correctly while the label above it still renders is a bug this
 * would otherwise miss.
 */
const WITHHELD = [
  'کاربران',
  'ارسال گروهی',
  'سفارشات',
  'سرویس‌ها',
  'تراکنش‌ها',
  'هزینه‌ها و تعدیل‌ها',
  'لیست درخواست‌ها',
  'دسترسی‌ها',
  // Admin-only rather than merely not-for-a-reader: `ADMIN_ONLY` in `nav.ts`
  // withholds «رویدادها» from a REVIEWER too, because a stack trace is not
  // part of reviewing payments and `eventRoutes.ts` answers 403 to anyone but
  // an ADMIN.
  'رویدادها',
];

/** What is left of twenty-four once those nine are gone. */
const OFFERED_TO_A_READER = 15;

async function signInAsReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(READER_EMAIL);
  await page.getByLabel('رمز عبور').fill(READER_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.locator('.sidebar-link.active')).toBeVisible();
}

test('a reader is offered fifteen sections of twenty-four, and the count is read off the screen', async ({
  page,
}) => {
  await signInAsReader(page);
  await expect(page.locator('.sidebar-link')).toHaveCount(OFFERED_TO_A_READER);
});

test('none of the nine withheld sections is drawn', async ({ page }) => {
  await signInAsReader(page);
  const sidebar = page.locator('.sidebar-link');
  for (const label of WITHHELD) {
    // Exact, because «سرویس‌ها» is a prefix of nothing here but «تراکنش‌ها»
    // appears inside finance copy elsewhere on the page — matching loosely
    // would pass on text that is not a link.
    await expect(sidebar.filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(0);
  }
});

test('the six payment screens are all there, because reviewing payments is the job', async ({
  page,
}) => {
  // The other direction, and the reason this file cannot simply count: a filter
  // that hid everything would pass a count assertion tuned to it and leave a
  // reviewer with an account that reviews nothing.
  await signInAsReader(page);
  const sidebar = page.locator('.sidebar-link');
  for (const label of ['پرداخت‌ها', 'آمار مالی', 'امروز', 'حساب‌ها', 'بانک‌ها', 'دستگاه‌ها']) {
    await expect(sidebar.filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
  }
});

test('the sidebar is a courtesy — the server refuses the data either way', async ({ page }) => {
  // The filter above is about not offering a broken door. It is NOT the
  // boundary, and a spec that stopped at the sidebar would read as though it
  // were. Asked here from inside the signed-in browser, with the reader's own
  // cookie, so this is the same request the panel would make.
  await signInAsReader(page);
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/v1/admin/customers?limit=1', { credentials: 'include' });
    return res.status;
  });
  expect(status).toBe(403);
});
