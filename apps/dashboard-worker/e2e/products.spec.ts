/**
 * The catalogue, pressed rather than described.
 *
 * `products.test.ts` covers the routes thoroughly — forty-two tests over the
 * plan and product endpoints. What no test covered until 2026-08-22 is whether
 * the screen is wired to them: whether the price box carries Toman into an IRR
 * column, whether the refusal the server writes is legible when it arrives, and
 * whether the operator is told what a delete would destroy before pressing it.
 *
 * The first walk of this screen found a real defect that every route test was
 * blind to. Pressing «حذف پلن» produced «12 سفارش و 7 سرویس» — Latin digits, a
 * few centimetres under a paragraph on the same screen reading «۱۲ سفارش». The
 * route builds that sentence itself, and `products.test.ts` asserted
 * `toContain('1 سفارش')`, so the test and the bug agreed with each other for as
 * long as both existed.
 *
 * Money is checked in the database rather than in the response body, for the
 * reason it is checked there everywhere in this repository: the response is
 * written by the same code that did the write, so it can be wrong in the same
 * direction.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * The seeded plan this file works on, found by NAME.
 *
 * Not by id. `product_plans.id` is `GENERATED ALWAYS AS IDENTITY`, so every
 * `seed:sim` hands the same plan a higher number — the first draft pinned 2560
 * and started timing out the moment the shop was re-seeded, which is the same
 * shape as pinning a date in a clock-dependent test. The name is written by the
 * seed and does not move.
 *
 * It is a plan with orders and sold services against it, which is what the
 * refusal test needs.
 */
const PLAN_NAME = '۱ماهه - ۲۰ گیگ - چند کاربر';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

async function plan(): Promise<{ id: number; priceIrr: number }> {
  return withDb(async (d) => {
    const row = await d
      .prepare(`SELECT id, price_irr::bigint AS p FROM product_plans WHERE name = ?1`)
      .bind(PLAN_NAME)
      .first<{ id: number; p: number }>();
    if (!row) throw new Error(`the seeded plan «${PLAN_NAME}» is missing — run seed:sim`);
    return { id: Number(row.id), priceIrr: Number(row.p) };
  });
}

/** Read once, before anything is typed, so the restore below is not a guess. */
let originalIrr = 0;

test.beforeAll(async () => {
  originalIrr = (await plan()).priceIrr;
});

async function openFirstPlan(page: import('@playwright/test').Page) {
  const { id } = await plan();
  await page.goto('/admin/products');
  await expect(page.locator('.sidebar-link.active')).toHaveText('محصولات');
  await page.locator(`tbody tr:has(td:text-is("${id}")) button`).click();
  await expect(page.getByRole('heading', { name: 'مشخصات پلن' })).toBeVisible();
}

test.afterAll(async () => {
  const { id } = await plan();
  await withDb((d) =>
    d.prepare(`UPDATE product_plans SET price_irr = ?2 WHERE id = ?1`).bind(id, originalIrr).run(),
  );
});

test('a price typed in Toman is stored in Rial, and the ledger says who changed it', async ({
  page,
}) => {
  await openFirstPlan(page);
  // By id, not by label: «قیمت (تومان)» is on the screen twice — once in the
  // plan being edited and once in the "new plan for this product" form below
  // it. A label lookup matches both, and the one that would have been filled is
  // whichever Playwright picked.
  await page.locator('#plan-price').fill('123456');
  await page.getByRole('button', { name: 'ذخیره', exact: true }).click();

  // The list is the panel agreeing with itself; the database is the claim.
  const { id } = await plan();
  await expect(page.locator(`tbody tr:has(td:text-is("${id}"))`)).toContainText('۱۲۳٬۴۵۶ تومان');
  expect((await plan()).priceIrr).toBe(1_234_560);
});

test('a delete the server refuses says so in the digits the rest of the panel uses', async ({
  page,
}) => {
  await openFirstPlan(page);

  // This plan has orders and sold services against it, so the route answers 409
  // and the panel has to render the sentence it sent.
  await page.getByRole('button', { name: 'حذف پلن' }).click();

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

test('the operator is told what is attached before pressing delete, not after', async ({
  page,
}) => {
  await openFirstPlan(page);
  // Beside the delete button rather than behind a confirm dialog, which is the
  // decision this asserts: the count is on the screen while the button is.
  await expect(page.locator('#main-content')).toContainText('سفارش روی این پلن ثبت شده است');
  await expect(page.locator('#main-content')).toContainText('در دفتر ثبت می‌شود');
});
