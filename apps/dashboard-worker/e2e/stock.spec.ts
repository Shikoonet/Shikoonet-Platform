/**
 * قفسهٔ انبار — accounts waiting to be handed to a customer, pressed.
 *
 * A row here is a working service. `subscription_url` is the whole credential:
 * whoever holds it has the account, and it is the one field on this panel where
 * showing it to the wrong person is the same as giving the service away.
 *
 * `stock.test.ts` proves the server's half — an ADMIN gets the link, a REVIEWER
 * gets the username and not the link. What no test could see is the browser's
 * half, and walking it on 2026-08-22 found that the SPA never rendered the
 * field at all: the credential travelled to the admin's browser on every page
 * load of this screen and was read by nobody, while an admin who wanted to
 * check a config before selling it had to open the database. The reveal button
 * this file asserts is what closed that.
 *
 * Everything is read back from the database, because the response is written by
 * the code that did the write.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const USERNAME = 'e2e-shelf-1';
const RETIRED = 'e2e-shelf-retired';
const URL_FOR = (u: string) => `https://panel.invalid/sub/${u}-secret`;

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const wipe = () =>
  withDb((d) =>
    d.prepare(`DELETE FROM provisioning_stock WHERE remote_username LIKE 'e2e-shelf-%'`).run(),
  );

/** A plan that has a panel behind it, found by name so a re-seed cannot move it. */
async function plan(): Promise<{ id: number }> {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT pl.id, pl.name, pr.name AS product
           FROM product_plans pl JOIN products pr ON pr.id = pl.product_id
          WHERE pl.name = ?1`,
      )
      .bind('اسپاتیفای - ۱ ماهه')
      .first<{ id: number; name: string; product: string }>();
    if (!row) throw new Error('the seeded plan is missing — run seed:sim');
    return { id: Number(row.id) };
  });
}

async function stockRow(username: string) {
  return withDb((d) =>
    d
      .prepare(
        `SELECT id, status, subscription_url, note, order_id
           FROM provisioning_stock WHERE remote_username = ?1`,
      )
      .bind(username)
      .first<{
        id: number;
        status: string;
        subscription_url: string;
        note: string | null;
        order_id: number | null;
      }>(),
  );
}

test.beforeAll(wipe);
test.afterAll(wipe);

test('a config added from the form lands on the shelf and is counted', async ({ page }) => {
  const p = await plan();

  await page.goto('/admin/stock');
  await expect(page.locator('.sidebar-link.active')).toHaveText('قفسهٔ انبار');
  await page.getByRole('button', { name: 'افزودن کانفیگ' }).click();
  // By id, not by the label. The option's TEXT is presentation — it collapses
  // a service and plan that share a name into one word — and a spec that
  // rebuilds that string is asserting the wording, not the behaviour it is
  // here for. The value is the plan.
  await page.locator('#add-plan').selectOption(String(p.id));
  await page.locator('#add-username').fill(USERNAME);
  await page.locator('#add-url').fill(URL_FOR(USERNAME));
  await page.getByRole('button', { name: 'افزودن', exact: true }).click();

  await expect(page.locator('#main-content')).toContainText('کانفیگ به قفسه اضافه شد.');

  const row = await stockRow(USERNAME);
  expect(row?.status).toBe('AVAILABLE');
  expect(row?.subscription_url).toBe(URL_FOR(USERNAME));
  // AVAILABLE and no order, which the `stock_used_has_order` CHECK ties
  // together: a shelf row cannot claim to be sold without naming the sale.
  expect(row?.order_id).toBeNull();
});

test('the link is not on the screen until somebody asks for it', async ({ page }) => {
  await page.goto('/admin/stock');
  const row = page.locator(`tbody tr:has-text("${USERNAME}")`);

  // The credential is in the response — an ADMIN is entitled to it — and it is
  // not in the document. A screen left open on a shared desk does not show
  // every unsold account on the shelf.
  await expect(page.locator('#main-content')).not.toContainText(URL_FOR(USERNAME));
  await expect(row.getByRole('button', { name: 'نمایش' })).toBeVisible();

  await row.getByRole('button', { name: 'نمایش' }).click();
  await expect(row.locator('code')).toHaveText(URL_FOR(USERNAME));
});

test('a retired row is not handed out, and its link stops being sent at all', async ({ page }) => {
  const p = await plan();
  await withDb((d) =>
    d
      .prepare(
        // The panel comes from the plan's product, never from a field — the
        // same rule `stockRoutes.ts` states and applies. Writing it any other
        // way here would let this fixture file a config on a panel the plan
        // does not sell from, which is the exact thing that rule prevents.
        `INSERT INTO provisioning_stock
           (plan_id, provider_id, remote_username, subscription_url, status)
         SELECT pl.id, p.provider_id, ?2, ?3, 'AVAILABLE'
           FROM product_plans pl JOIN products p ON p.id = pl.product_id
          WHERE pl.id = ?1`,
      )
      .bind(p.id, RETIRED, URL_FOR(RETIRED))
      .run(),
  );

  await page.goto('/admin/stock');
  const row = page.locator(`tbody tr:has-text("${RETIRED}")`);
  page.once('dialog', (d) => {
    // The question names the account and what retiring costs, rather than a
    // bare "are you sure".
    expect(d.message()).toContain(RETIRED);
    expect(d.message()).toContain('دیگر به هیچ سفارشی داده نمی‌شود');
    void d.accept();
  });
  await row.getByRole('button', { name: 'بازنشسته' }).click();
  await expect(page.locator('#main-content')).toContainText('بازنشسته شد.');

  expect((await stockRow(RETIRED))?.status).toBe('RETIRED');

  // And the row stops carrying its credential — the gate is `AVAILABLE`, not
  // merely "an admin is asking". A retired account is one nobody should be
  // copying a link out of.
  await page.reload();
  const retiredRow = page.locator(`tbody tr:has-text("${RETIRED}")`);
  await expect(retiredRow.getByRole('button', { name: 'نمایش' })).toHaveCount(0);
  await expect(page.locator('#main-content')).not.toContainText(URL_FOR(RETIRED));
});
