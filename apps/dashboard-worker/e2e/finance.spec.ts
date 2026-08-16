/**
 * The «پول» group still does everything it did as its own dashboard.
 *
 * Sam's instruction on 2026-08-16, after the merge was on screen: make sure
 * nothing of the payment hub's behaviour was left behind. The screens were easy
 * to check — they render, and `panel.spec.ts` opens all twenty-two under one
 * session. What is hard to see is the wiring *between* them, because a broken
 * wire here still looks like a working panel: the sidebar highlights the right
 * section and the screen draws, and only the destination is wrong.
 *
 * Two were actually broken when this was written:
 *
 *   - `App.tsx` took `(id, search)` from the bell and passed only `id` on, so
 *     every notification landed on whichever payment tab was the default.
 *   - Clicking the bell while already on payments moved nothing, because
 *     `replaceState` does not fire `popstate` and the tab is only read from the
 *     URL. That one predates the merge — it never worked.
 *
 * Neither shows up in a unit test that renders one component, and neither is
 * visible in a screenshot. They need the real thing.
 */

import { expect, test } from '@playwright/test';

const SECTIONS = ['payments', 'statistics', 'today', 'accounts', 'banks', 'devices'] as const;

test('the notification bell opens the tab it names, from another section', async ({ page }) => {
  await page.goto('/admin/today');
  await expect(page.locator('.hub')).toBeVisible();

  await page.getByRole('button', { name: /اعلان‌ها/ }).click();
  await page.locator('.count--income').click();

  // The section and the tab, not just the section. The URL is the assertion
  // because it is also the mechanism: `PaymentsView` reads `?tab=` on mount and
  // has no other way to be told.
  await expect(page).toHaveURL(/\/admin\/payments\?tab=income$/);
  await expect(page.locator('.sidebar-link.active')).toHaveText('پرداخت‌ها');
  await expect(page.locator('.ops-nav__subtab--active').first()).toContainText('واریزی‌ها');
});

test('the bell changes tab even when the payments screen is already open', async ({ page }) => {
  await page.goto('/admin/payments?tab=income');
  await expect(page.locator('.ops-nav__subtab--active').first()).toContainText('واریزی‌ها');

  await page.getByRole('button', { name: /اعلان‌ها/ }).click();
  await page.locator('.count--verified').click();

  await expect(page).toHaveURL(/\/admin\/payments\?tab=bot_auto_verified$/);
  await expect(page.locator('.ops-nav__subtab--active').first()).toContainText('تایید خودکار ربات');
});

test('a payment tab can be linked to, and clicking one writes the link', async ({ page }) => {
  await page.goto('/admin/payments?tab=waiting');
  await expect(page.locator('.ops-nav__subtab--active').first()).toContainText('در انتظار');

  await page.getByRole('tab', { name: /مشکوک به جعل/ }).click();
  await expect(page).toHaveURL(/tab=suspected_fake$/);

  // `replaceState`, so Back leaves the payments screen rather than stepping
  // backwards through nine sub-tabs. Deliberate, and asserted so it stays that
  // way — `paymentsNav.tsx` has carried the reasoning since before the merge.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/admin\/payments/);
});

for (const section of SECTIONS) {
  test(`the ${section} screen loads with nothing refused and nothing thrown`, async ({ page }) => {
    const failed: string[] = [];
    const thrown: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    page.on('pageerror', (e) => thrown.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') thrown.push(m.text());
    });

    await page.goto(`/admin/${section}`);
    await expect(page.locator('.hub')).toBeVisible();
    // Long enough for the cache's first poll cycle to come back — a screen that
    // renders and then fails on its second fetch is the failure mode a bare
    // render check misses.
    await page.waitForTimeout(1200);

    expect(failed).toEqual([]);
    expect(thrown).toEqual([]);
  });
}
