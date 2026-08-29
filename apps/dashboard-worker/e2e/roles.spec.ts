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
import { LOGIN_PORT } from '../playwright.config.js';

/**
 * The front-door server's address, from the config rather than typed.
 *
 * It was `http://127.0.0.1:8800` in three specs until 2026-08-24, when a Docker
 * Desktop restart moved Windows' Hyper-V port reservations over that number and
 * the whole suite died at startup. The port is probed now, so it has to be
 * imported.
 */
const BASE = `http://127.0.0.1:${LOGIN_PORT}`;

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
  // Customer subscriptions. It was «سرویس‌ها» until 2026-08-24, when that name
  // went to the catalogue — which a reader IS offered. Two sections named the
  // same thing is exactly why this list is written in labels: if the rename had
  // been done in ids alone, this test would have gone on passing while the
  // sidebar handed a reader the wrong one.
  'اشتراک‌های مشتری',
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

/**
 * What is left of twenty-seven once those nine are gone.
 *
 * Fifteen of twenty-four until 2026-08-27. «محصولات» and «دسته‌بندی‌ها» are both
 * in `READABLE_BY_READER`, so both new sections raise this count rather than the
 * withheld list — a reader may see what the shop sells and how it is arranged,
 * and every write on those screens already answers 403 for this role.
 *
 * Eighteen on 2026-08-29. «ربات تلگرام» is readable too, and deliberately: the
 * page holds no token — the server has no field that could carry one — and what
 * it names is a bot's username, which is public the moment anybody opens the
 * shop. The write behind it is ADMIN-only and `write-roles.test.ts` counts it.
 */
const OFFERED_TO_A_READER = 18;

async function signInAsReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(READER_EMAIL);
  await page.getByLabel('رمز عبور').fill(READER_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.locator('.sidebar-link.active')).toBeVisible();
}

test('a reader is offered eighteen sections of twenty-seven, and the count is read off the screen', async ({
  page,
}) => {
  await signInAsReader(page);
  await expect(page.locator('.sidebar-link')).toHaveCount(OFFERED_TO_A_READER);
});

test('none of the nine withheld sections is drawn', async ({ page }) => {
  await signInAsReader(page);
  const sidebar = page.locator('.sidebar-link');
  for (const label of WITHHELD) {
    // Exact, because «تراکنش‌ها» appears inside finance copy elsewhere on the
    // page — matching loosely would pass on text that is not a link.
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
