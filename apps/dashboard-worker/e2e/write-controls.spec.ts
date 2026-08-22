/**
 * Nothing that writes is left pressable, on any section a reader can open.
 *
 * `roles.spec.ts` proves the sidebar is filtered. This is the level below it,
 * and it is the gap that proof found and did not close: inside the fifteen
 * sections a READ_ONLY operator *is* offered, every «ذخیره», «حذف» and «تازه»
 * was drawn exactly as it is for the shop's owner, and pressing one answered
 * 403. The server was never in doubt — `write-roles.test.ts` asks all 114 write
 * routes and they all refuse — so what is asserted here is the panel, not the
 * boundary.
 *
 * ## Why the check is a list of verbs rather than a list of buttons
 *
 * A spec naming the buttons it knows about proves only that those buttons were
 * fixed on the day it was written. The failure this repository actually has is
 * the *next* one: a control added six weeks from now, in a file whose other
 * controls all carry the guard, by somebody who read a comment saying they do.
 *
 * So the sweep goes the other way. It collects every button on the page that is
 * still pressable and fails if any of them is *named* like a write. The list
 * below is the shop's own vocabulary — the verbs the panel already uses — and a
 * new button that saves something will be called «ذخیره» or «افزودن» like all
 * the others. A class name would not do: «جست‌وجو» is a `btn-primary` submit
 * and is a read.
 *
 * The heuristic can be wrong in one direction only. A write named with a word
 * nobody has used before slips through — a real ceiling, written down here
 * rather than implied. It cannot be wrong in the other: a read that gets
 * disabled fails the last test in this file, which is the control.
 */

import { expect, test, type Page } from '@playwright/test';
import { READER_EMAIL, READER_PASSWORD } from './global-setup.js';

const BASE = 'http://127.0.0.1:8800';

test.use({ baseURL: BASE });

/**
 * The fifteen sections `nav.ts` offers a READ_ONLY operator.
 *
 * Written out rather than read from the sidebar, because the sidebar is what
 * `roles.spec.ts` measures — deriving this list from it would make one filter
 * prove itself twice and neither of them prove this.
 */
const READER_SECTIONS = [
  'dashboard',
  'payments',
  'statistics',
  'today',
  'accounts',
  'banks',
  'devices',
  'products',
  'panels',
  'stock',
  'discounts',
  'texts',
  'keyboard',
  'content',
  'settings',
];

/** What the panel calls the things that change something. */
const WRITE_VERBS = [
  'ذخیره',
  'حذف',
  'افزودن',
  'ساخت',
  'تازه',
  'تایید',
  'پذیرش',
  'غیرفعال‌کردن',
  'فعال‌کردن',
  'بازگشت به پیش‌فرض',
  'چرخش توکن',
  'ابطال توکن',
  'تخصیص',
  'علامت‌زدن',
  'اجرای دوبارهٔ تخصیص',
  'بازکردن دوبارهٔ تایید',
  'بازگرداندن',
  'به‌روزرسانی',
];

async function signInAsReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(READER_EMAIL);
  await page.getByLabel('رمز عبور').fill(READER_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.locator('.sidebar-link.active')).toBeVisible();
}

/**
 * Every button still pressable, by the name a person reads off it.
 *
 * Sortable column headers and tab strips are out. Both are `<button>` because
 * that is what a keyboard-operable control is, and neither changes anything —
 * they change what is *shown*. Leaving them in did not find a bug, it found
 * «ساخته‌شده↕», a column heading, and «تایید خودکار ربات», a filter. A sweep
 * that cries wolf gets its verb list trimmed until it is silent, and then it
 * catches nothing.
 */
async function pressableLabels(page: Page): Promise<string[]> {
  const SELECTOR = '#main-content button:not([disabled]):not(.th-button):not([role="tab"])';
  return page.$$eval(SELECTOR, (els) =>
    els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t !== ''),
  );
}

test('no section offers a reader a control that writes', async ({ page }) => {
  await signInAsReader(page);

  const offered: string[] = [];
  for (const section of READER_SECTIONS) {
    await page.goto(`${BASE}/admin/${section}`);
    // The banner is the first thing rendered from `role`, so waiting on it is
    // waiting for the identity — without it the sweep can read a page drawn
    // before `/auth/me` answered, where every control is still enabled by
    // design and the assertion below passes for the wrong reason.
    await expect(page.locator('#main-content .alert-info').first()).toBeVisible();
    for (const label of await pressableLabels(page)) {
      if (WRITE_VERBS.some((v) => label.includes(v))) offered.push(`${section}: ${label}`);
    }
  }
  expect(offered).toEqual([]);
});

test('the reads are untouched, so the sections are still worth opening', async ({ page }) => {
  // The control. A change that disabled every button would pass the sweep above
  // and hand a reviewer fifteen screens they cannot filter, page or search —
  // which is worse than the bug being fixed, and invisible to a test that only
  // counts what is off.
  await signInAsReader(page);

  await page.goto(`${BASE}/admin/products`);
  await expect(page.getByRole('button', { name: 'جست‌وجو' })).toBeEnabled();
  await expect(page.locator('#prod-q')).toBeEditable();

  await page.goto(`${BASE}/admin/discounts`);
  await expect(page.getByRole('button', { name: 'جست‌وجو' })).toBeEnabled();
});

test('a withheld section says so instead of drawing itself', async ({ page }) => {
  // Typed by hand, or opened from a bookmark made on somebody else's account.
  // The sidebar filter stands beside the door and this one is in it: before
  // this, `Body` drew «کاربران» in full and let it fill with its own 403s.
  await signInAsReader(page);
  await page.goto(`${BASE}/admin/customers`);

  await expect(page.locator('#main-content')).toContainText('برای نقش شما باز نیست');
  await expect(page.locator('table.app-table')).toHaveCount(0);
});
