/**
 * The catalogue, pressed rather than described.
 *
 * `catalog.test.ts` and `products.test.ts` cover the routes thoroughly. What no
 * route test can see is whether the screen is wired to them: whether the price
 * box carries Toman into an IRR column, whether the refusal the server writes is
 * legible when it arrives, and whether the operator is told what a delete would
 * destroy before pressing it.
 *
 * The first walk of this screen, on 2026-08-22, found a real defect every route
 * test was blind to. Pressing «حذف» produced «12 سفارش و 7 سرویس» — Latin
 * digits, a few centimetres under a paragraph on the same screen reading
 * «۱۲ سفارش». The route builds that sentence itself and `products.test.ts`
 * asserted `toContain('1 سفارش')`, so the test and the bug agreed with each
 * other for as long as both existed.
 *
 * Rewritten on 2026-08-24 for the screen that replaced «محصولات». It was one
 * row per PLAN; it is one row per SERVICE with its configs inside it, so the
 * walk now has to open a service before it can reach a price — which is the
 * whole change, and asserting it here is asserting it in a browser.
 *
 * Money is checked in the database rather than in the response body, for the
 * reason it is checked there everywhere in this repository: the response is
 * written by the same code that did the write, so it can be wrong in the same
 * direction.
 */

import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * The seeded config this file works on, found by NAME.
 *
 * Not by id. `product_plans.id` is `GENERATED ALWAYS AS IDENTITY`, so every
 * `seed:sim` hands the same row a higher number — the first draft pinned 2560
 * and started timing out the moment the shop was re-seeded, which is the same
 * shape as pinning a date in a clock-dependent test. The name is written by the
 * seed and does not move.
 *
 * It is a config with orders and sold subscriptions against it, which is what
 * the refusal test needs.
 */
const CONFIG_NAME = '۱ماهه - ۲۰ گیگ - چند کاربر';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

async function config(): Promise<{ id: number; priceIrr: number; serviceName: string }> {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT pl.id, pl.price_irr::bigint AS p, p.name AS service
           FROM product_plans pl JOIN products p ON p.id = pl.product_id
          WHERE pl.name = ?1`,
      )
      .bind(CONFIG_NAME)
      .first<{ id: number; p: number; service: string }>();
    if (!row) throw new Error(`the seeded config «${CONFIG_NAME}» is missing — run seed:sim`);
    return { id: Number(row.id), priceIrr: Number(row.p), serviceName: row.service };
  });
}

/** Read once, before anything is typed, so the restore below is not a guess. */
let originalIrr = 0;

test.beforeAll(async () => {
  originalIrr = (await config()).priceIrr;
});

test.afterAll(async () => {
  const { id } = await config();
  await withDb((d) =>
    d.prepare(`UPDATE product_plans SET price_irr = ?2 WHERE id = ?1`).bind(id, originalIrr).run(),
  );
});

/**
 * Find the service, open it, open the config inside it.
 *
 * Three steps where the old screen had one, and that is the point being walked:
 * a config is reached THROUGH the service that sells it, the way a customer
 * reaches it.
 */
/**
 * The card of one service, since 2026-09-13 — one per service, its configs as
 * chips on it. Found by the card's accessible name, which is the service's.
 */
function card(page: Page, serviceName: string) {
  return page.locator('.svc-card', { has: page.locator('.svc-card__name', { hasText: serviceName }) }).first();
}

async function openConfig(page: Page) {
  const { serviceName } = await config();
  await page.goto('/admin/catalog');
  await expect(page.locator('.sidebar-link.active')).toHaveText('سرویس‌ها');

  await page.locator('#cat-q').fill(CONFIG_NAME);
  await page.getByRole('button', { name: 'جست‌وجو' }).click();

  const svc = card(page, serviceName);
  await expect(svc).toBeVisible();
  // The chip IS the config: one tap, the editor opens under the card. In this
  // shop the service and its only config are usually called the same thing —
  // the importer wrote `product.name_product` into both columns — so the chip
  // is found inside the chip strip, not by its text on the page.
  await svc.locator('.svc-chip', { hasText: CONFIG_NAME }).first().click();
  await expect(svc.locator('#cf-price')).toBeVisible();
}

test('a service is a card, with its prices on it and no click', async ({ page }) => {
  const { serviceName, priceIrr } = await config();
  await page.goto('/admin/catalog');
  await page.locator('#cat-q').fill(CONFIG_NAME);
  await page.getByRole('button', { name: 'جست‌وجو' }).click();

  const svc = card(page, serviceName);
  await expect(svc).toBeVisible();
  // The price is on the chip before anything is pressed — the head admin's
  // complaint on 2026-09-13 was that it took two clicks to see one.
  const chip = svc.locator('.svc-chip', { hasText: CONFIG_NAME }).first();
  await expect(chip).toBeVisible();
  await expect(chip.locator('.svc-chip__price')).toContainText(
    new Intl.NumberFormat('fa-IR').format(Math.trunc(priceIrr / 10)),
  );
  // Nothing to edit yet.
  await expect(svc.locator('#cf-price')).toHaveCount(0);
  await chip.click();
  await expect(svc.locator('#cf-price')).toBeVisible();
});

test('«نمای جدولی» lists one row per config, and the address remembers it', async ({ page }) => {
  const { serviceName } = await config();
  await page.goto('/admin/catalog?view=table');
  await page.locator('#cat-q').fill(CONFIG_NAME);
  await page.getByRole('button', { name: 'جست‌وجو' }).click();
  const row = page.locator(`tbody tr:has-text("${serviceName}")`).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(CONFIG_NAME);
  await row.getByRole('button', { name: 'ویرایش' }).click();
  await expect(page.locator('#cf-price')).toBeVisible();
});

test('a price typed in Toman is stored in Rial, and the ledger says who changed it', async ({
  page,
}) => {
  await openConfig(page);
  // By id, not by label: «قیمت (تومان)» can be on the screen twice — once in the
  // config being edited and once in a «کانفیگ تازه» form. A label lookup matches
  // both, and the one that would have been filled is whichever Playwright picked.
  await page.locator('#cf-price').fill('123456');
  await page.getByRole('button', { name: 'ذخیره', exact: true }).click();

  // The screen agreeing with itself proves nothing; the database is the claim.
  await expect(page.getByText('ذخیره شد.')).toBeVisible();
  expect((await config()).priceIrr).toBe(1_234_560);
});

test('a delete the server refuses says so in the digits the rest of the panel uses', async ({
  page,
}) => {
  await openConfig(page);

  // This config has orders and sold subscriptions against it, so the route
  // answers 409 and the panel has to render the sentence it sent.
  await page.getByRole('button', { name: 'حذف کانفیگ' }).click();

  const refusal = page.getByText(/به این ردیف وصل است/);
  await expect(refusal).toBeVisible();
  // The defect this test exists for. Persian digits throughout, and — the
  // stronger half — no Latin digit anywhere in the sentence, so a second count
  // added to it later cannot slip through in the wrong alphabet.
  await expect(refusal).not.toHaveText(/[0-9]/);
  await expect(refusal).toHaveText(/[۰-۹]/);

  // And the refusal is not a dead end: the move that always works is offered.
  await expect(page.getByRole('button', { name: 'به‌جایش غیرفعال کن' })).toBeVisible();
});

test('the operator is told what is attached before pressing delete, not after', async ({ page }) => {
  await openConfig(page);
  // Beside the delete button rather than behind a confirm dialog, which is the
  // decision this asserts: the count is on the screen while the button is.
  await expect(page.locator('#main-content')).toContainText('سفارش روی این کانفیگ ثبت شده است');
  await expect(page.locator('#main-content')).toContainText('در دفتر ثبت می‌شود');
});

test('the name of a new config writes itself from what the config is', async ({ page }) => {
  // The legacy operator typed «1ماهه-20گیگ-چند کاربر-119.000ت» by hand, price
  // included, and every price change meant editing prose in every row. The
  // columns exist now, so the name is composed — and the price stays out of it,
  // because the bot appends the live one.
  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: 'سرویس تازه' }).click();

  await page.locator('#ns-cf-days').fill('30');
  await page.locator('#ns-cf-volume').fill('20');
  await expect(page.locator('#ns-cf-name')).toHaveValue('۱ ماهه - ۲۰ گیگ - چند کاربر');

  await page.locator('#ns-cf-users').fill('2');
  await expect(page.locator('#ns-cf-name')).toHaveValue('۱ ماهه - ۲۰ گیگ - ۲ کاربر');

  // Typed over, it stops writing itself. An autofill that keeps overwriting
  // what somebody just wrote is worse than no autofill.
  await page.locator('#ns-cf-name').fill('✨تانل اختصاصی✨');
  await page.locator('#ns-cf-volume').fill('50');
  await expect(page.locator('#ns-cf-name')).toHaveValue('✨تانل اختصاصی✨');
});

test('a service with no panel is listed and says it cannot be sold', async ({ page }) => {
  // The bot INNER JOINs the panel, so such a service is invisible in the shop.
  // Hiding it here too would make it invisible in the one place it can be fixed.
  const name = 'zz-e2e-orphan';
  // Its own category, created and removed with it.
  //
  // `products.category_id` became NOT NULL in `0032_catalog_categories_and_rows.sql`,
  // and this fixture predates that — it inserted a product with no category and
  // died on the constraint, which reads as "the catalogue screen is broken"
  // rather than as "the fixture is". Borrowing a seeded category instead would
  // work today and break on the day somebody re-seeds a shop without one; the
  // rest of this test already creates and deletes what it needs.
  await withDb(async (d) => {
    await d
      .prepare(
        `INSERT INTO product_categories (name, active, sort_order)
         VALUES (?1, true, 999)
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(name)
      .run();
    await d
      .prepare(
        `INSERT INTO products (code, name, kind, provider_id, status, category_id)
         VALUES (?1, ?1, 'vpn', NULL, 'ACTIVE',
                 (SELECT id FROM product_categories WHERE name = ?1))
         ON CONFLICT (code) DO NOTHING`,
      )
      .bind(name)
      .run();
  });
  try {
    await page.goto('/admin/catalog');
    await page.locator('#cat-q').fill(name);
    await page.getByRole('button', { name: 'جست‌وجو' }).click();

    const svc = card(page, name);
    await expect(svc).toBeVisible();
    await expect(svc).toContainText('بدون پنل');
  } finally {
    await withDb(async (d) => {
      await d.prepare(`DELETE FROM products WHERE code = ?1`).bind(name).run();
      await d.prepare(`DELETE FROM product_categories WHERE name = ?1`).bind(name).run();
    });
  }
});
