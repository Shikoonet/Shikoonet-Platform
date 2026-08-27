/**
 * «چه چیزی واقعاً در فروشگاه دیده می‌شود» — pressed in a browser.
 *
 * On 2026-08-27 the dashboard said «۱۶ محصول، همه در فروشگاه» and the bot sold
 * three. Five of seven panels were switched off, so thirteen products could not
 * be delivered to anybody, and «محصولات» drew a green badge over every one of
 * them. The data was never missing: `provider.status` already arrived on each
 * row and the screen drew the PLAN's status instead.
 *
 * `apps/bot/test/sellable.test.ts` proves the RULE against the bot's own
 * keyboard, and `apps/admin-web/test/sellable-screens.test.tsx` proves the
 * components print it. Neither can see what this file is for: whether the built
 * SPA, served by the real server, against a real database, actually draws it —
 * and whether the button that took the blame («دکمه چیدمان خرابه کار نمیکنه»)
 * now goes somewhere.
 *
 * The panel is switched off in the DATABASE rather than through the panel
 * screen, on purpose. What is under test is whether these screens READ that
 * state, so writing it through a UI that might share the same misreading would
 * be the two-definitions problem this whole change exists to remove.
 */

import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * Fixtures found by NAME, never by id.
 *
 * `provisioning_providers.id` is `GENERATED ALWAYS AS IDENTITY`, so every
 * `seed:sim` hands the same panel a higher number — `catalog.spec.ts` learned
 * this by pinning 2560 and timing out the moment the shop was re-seeded.
 */
const ACCOUNTS_PANEL = '📦 اکانت‌ها (شبیه‌سازی)';
const ACCOUNTS_CATEGORY = 'اکانت‌ها';
const VPN_CATEGORY = 'وی‌پی‌ان';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

/** Returns the number of rows changed, so a silent no-op cannot pass as a fixture. */
async function setPanelStatus(name: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
  const changed = await withDb(async (d) => {
    const r = await d
      .prepare(`UPDATE provisioning_providers SET status = ?2 WHERE name = ?1`)
      .bind(name, status)
      .run();
    return r.meta.changes ?? 0;
  });
  // A fixture that quietly matched nothing would leave every assertion below
  // testing the untouched shop and passing for the wrong reason.
  expect(changed, `no panel named «${name}» — run seed:sim`).toBeGreaterThan(0);
}

/** The sentence under «دسته‌بندی‌ها»'s heading, whichever of the three it is. */
function firstScreenSentence(page: Page) {
  return page.locator('p.muted').first();
}

test('the arrangement button works with no filter chosen, and lands on «دسته‌بندی‌ها»', async ({
  page,
}) => {
  // The complaint was «دکمه چیدمان خرابه کار نمیکنه». It was `disabled` until a
  // category was picked, and nothing on the screen said so — a button that is
  // grey on arrival reads as broken, not as conditional. So the walk touches no
  // filter at all: fresh page, straight to the button.
  await page.goto('/admin/products');
  await expect(page.locator('.page-head__title')).toHaveText('محصولات');

  const arrange = page.getByRole('button', { name: 'چیدمان در ربات' });
  await expect(arrange).toBeEnabled();
  await arrange.click();

  await expect(page.locator('.page-head__title')).toHaveText('دسته‌بندی‌ها');
  expect(new URL(page.url()).pathname).toBe('/admin/categories');
});

/** «۱۳ محصول · ۱۰ قابل خرید» → `{ total: 13, sellable: 10 }`. */
async function headCounts(page: Page): Promise<{ total: number; sellable: number }> {
  // Scoped to the heading. `page-head__sub` is also the class the table cells
  // use for the reason under «فروخته نمی‌شود», so an unscoped locator matches
  // seven elements — which is how this assertion first failed.
  const text = await page.locator('.page-head .page-head__sub').first().innerText();
  const fa = (m: string) => Number(m.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
  const total = text.match(/([۰-۹]+)\s*محصول/);
  const sellable = text.match(/([۰-۹]+)\s*قابل خرید/);
  if (!total || !sellable) throw new Error(`heading did not carry both counts: «${text}»`);
  return { total: fa(total[1]!), sellable: fa(sellable[1]!) };
}

test('switching a panel off moves exactly its configs out of «قابل خرید»', async ({ page }) => {
  // The strongest form of the claim this screen makes. Asserting that the
  // heading merely CONTAINS «قابل خرید» would have passed on the old screen
  // too, where both numbers were the same lie. So the outside truth is asked of
  // Postgres first — how many configs this panel really sells — and then the
  // panel is switched off and the heading has to move by exactly that much.
  const onPanel = await withDb(async (d) => {
    const r = await d
      .prepare(
        `SELECT count(*)::int AS n
           FROM product_plans pl
           JOIN products p ON p.id = pl.product_id
           JOIN provisioning_providers pr ON pr.id = p.provider_id
          WHERE pr.name = ?1
            AND pr.status = 'ACTIVE' AND p.status = 'ACTIVE' AND pl.status = 'ACTIVE'`,
      )
      .bind(ACCOUNTS_PANEL)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  });
  expect(onPanel, `«${ACCOUNTS_PANEL}» sells nothing — run seed:sim`).toBeGreaterThan(0);

  await page.goto('/admin/products');
  const before = await headCounts(page);
  expect(before.sellable).toBeGreaterThanOrEqual(onPanel);

  await setPanelStatus(ACCOUNTS_PANEL, 'DISABLED');
  try {
    await page.goto('/admin/products');
    const after = await headCounts(page);
    // Nothing was deleted — the shop still HAS them, it just cannot sell them.
    // That distinction is the entire point of carrying two numbers.
    expect(after.total).toBe(before.total);
    expect(after.sellable).toBe(before.sellable - onPanel);
  } finally {
    await setPanelStatus(ACCOUNTS_PANEL, 'ACTIVE');
  }

  await page.goto('/admin/products');
  expect(await headCounts(page)).toEqual(before);
});

test('a config on a switched-off panel says so, and says it in the shop’s voice', async ({
  page,
}) => {
  await setPanelStatus(ACCOUNTS_PANEL, 'DISABLED');
  try {
    await page.goto('/admin/products');
    await page.locator('#prod-sellable').selectOption('no');
    await page.getByRole('button', { name: 'جست‌وجو' }).click();

    const table = page.locator('table').first();
    await expect(table.getByText('فروخته نمی‌شود').first()).toBeVisible();
    // The reason, not the column. «پنل خاموش» is the sentence that tells an
    // operator where to go; the row's own status is still ACTIVE and says
    // nothing about why nobody can buy it.
    await expect(table.getByText('پنل خاموش').first()).toBeVisible();
  } finally {
    await setPanelStatus(ACCOUNTS_PANEL, 'ACTIVE');
  }
});

test('the collapse sentence appears only while one category can sell', async ({ page }) => {
  // The plan's proof row: make the second category sellable and the sentence
  // must go. Written in that order — the shop starts with two — so a sentence
  // that never rendered at all cannot pass this by being absent twice.
  await page.goto('/admin/categories');
  await expect(firstScreenSentence(page)).toContainText('دکمه');
  await expect(firstScreenSentence(page)).not.toContainText('ربات این صفحه را رد می‌کند');

  await setPanelStatus(ACCOUNTS_PANEL, 'DISABLED');
  try {
    await page.goto('/admin/categories');
    const sentence = firstScreenSentence(page);
    // `handle.ts:1188` — «a list of one is not a choice» — skips the category
    // screen entirely. That behaviour was always right; nothing anywhere said
    // it happened, which is what «دسته‌بندی‌ها اصلا چیکار میکنن؟» was asking.
    await expect(sentence).toContainText('ربات این صفحه را رد می‌کند');
    await expect(sentence).toContainText(VPN_CATEGORY);

    // And the category that went dark is named as invisible rather than left
    // wearing «در فروشگاه», which is the badge that started all of this.
    const card = page.locator('.cat-grid > *', { hasText: ACCOUNTS_CATEGORY }).first();
    await expect(card.getByText('در ربات دیده نمی‌شود')).toBeVisible();
  } finally {
    await setPanelStatus(ACCOUNTS_PANEL, 'ACTIVE');
  }

  await page.goto('/admin/categories');
  await expect(firstScreenSentence(page)).not.toContainText('ربات این صفحه را رد می‌کند');
  await expect(firstScreenSentence(page)).toContainText('دکمه');
});
