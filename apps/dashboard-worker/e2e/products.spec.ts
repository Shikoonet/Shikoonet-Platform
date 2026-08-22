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

/** The seeded plan the simulation shop is built around. */
const PLAN = 2560;
const ORIGINAL_IRR = 1_000_000;

async function planPriceIrr(): Promise<number> {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    const row = await db
      .prepare(`SELECT price_irr::bigint AS p FROM product_plans WHERE id = ?1`)
      .bind(PLAN)
      .first<{ p: number }>();
    return Number(row?.p ?? -1);
  } finally {
    await pool.end();
  }
}

async function openFirstPlan(page: import('@playwright/test').Page) {
  await page.goto('/admin/products');
  await expect(page.locator('.sidebar-link.active')).toHaveText('محصولات');
  await page.locator(`tbody tr:has(td:text-is("${PLAN}")) button`).click();
  await expect(page.getByRole('heading', { name: 'مشخصات پلن' })).toBeVisible();
}

test.afterAll(async () => {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    await db
      .prepare(`UPDATE product_plans SET price_irr = ?2 WHERE id = ?1`)
      .bind(PLAN, ORIGINAL_IRR)
      .run();
  } finally {
    await pool.end();
  }
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
  await expect(page.locator(`tbody tr:has(td:text-is("${PLAN}"))`)).toContainText('۱۲۳٬۴۵۶ تومان');
  expect(await planPriceIrr()).toBe(1_234_560);
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
