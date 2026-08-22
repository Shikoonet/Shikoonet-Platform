/**
 * سفارشات · سرویس‌ها · تراکنش‌ها — the three read-only ledgers, pressed.
 *
 * Nothing on these screens writes, which makes them look like the safest part
 * of the panel and is exactly why they were walked. A list that cannot corrupt
 * anything can still send an admin to the database, or state a figure about
 * the shop that is not true, and walking all three on 2026-08-22 found one of
 * each:
 *
 *   * an identifier printed in a column and refused by the search box —
 *     `FX-0012` on سفارشات, the panel account name on سرویس‌ها. Both are what
 *     support starts from: a customer quotes an order number, and a panel shows
 *     an account name and nothing about who owns it;
 *   * an add-on order rendering «—» where its content belongs. `ADD_VOLUME`
 *     and `ADD_TIME` are placed with no plan, so the quantity IS the product,
 *     and it never reached the screen. The legacy dump carries 37 of these;
 *   * three totals scoped to the filter — correctly, and the route says so —
 *     under labels that claimed the whole shop.
 *
 * The totals are asserted against a sum taken here, in SQL, rather than
 * against the route's own answer: a page that agrees with the query that fed
 * it proves the transport and nothing about the number.
 *
 * No wallet row is written by this file. `wallet_entries` is append-only in
 * Postgres — `trg_wallet_entries_append_only` refuses DELETE and UPDATE — so a
 * fixture here would be permanent. The ledger is read as it stands instead,
 * which is the stronger test anyway.
 */

import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * Ten hex characters, which is what `newPublicId()` issues
 * (`randomBytes(5).toString('hex')`) and two more than any legacy invoice id.
 *
 * The length is the point. Every one of the 5,131 ids in the dump is exactly
 * eight characters, so `publicId.slice(0, 8)` on the شناسه column looked
 * correct for as long as the shop ran on PHP and cut the last two off every
 * order our own bot placed — while the bot quotes the whole id to the
 * customer. A fixture that is eight characters long cannot see that.
 */
const ORDER_ID = 'e2e1a2b3c4';
const PANEL_ACCOUNT = 'e2e-ledger-acct';
const ADDON_GB = 20;

const fa = new Intl.NumberFormat('fa-IR');

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const wipe = () =>
  withDb(async (d) => {
    await d.prepare(`DELETE FROM orders WHERE public_id = ?1`).bind(ORDER_ID).run();
    await d
      .prepare(`DELETE FROM subscriptions WHERE remote_username = ?1`)
      .bind(PANEL_ACCOUNT)
      .run();
  });

test.beforeAll(async () => {
  await wipe();
  await withDb(async (d) => {
    // A subscription whose panel account name is the thing being searched for.
    // Its owner is whoever the seed made first — the test never names a
    // customer, because `users.id` is an identity column and moves on re-seed.
    await d
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, plan_id, provider_id, provider_name_at_sale,
            plan_name_at_sale, price_irr, remote_username, status, purchased_at)
         SELECT 'FXS-E2E-1', s.user_id, s.plan_id, s.provider_id, s.provider_name_at_sale,
                s.plan_name_at_sale, s.price_irr, ?1, 'ACTIVE', now()
           FROM subscriptions s ORDER BY s.id LIMIT 1`,
      )
      .bind(PANEL_ACCOUNT)
      .run();

    // An add-on order, placed the way `placeAddonOrder` places one: no plan,
    // pointing at the service it tops up, and a quantity that is the gigabytes
    // bought. The `total = unit x quantity - discount` CHECK is what keeps the
    // three numbers honest, so writing them wrong here would be refused.
    await d
      .prepare(
        `INSERT INTO orders
           (public_id, user_id, kind, plan_id, target_subscription_id,
            quantity, unit_price_irr, discount_irr, total_irr, status, created_at, completed_at)
         SELECT ?1, s.user_id, 'ADD_VOLUME', NULL, s.id,
                ?2, 25000, 0, ?3, 'COMPLETED', now(), now()
           FROM subscriptions s WHERE s.remote_username = ?4`,
      )
      .bind(ORDER_ID, ADDON_GB, ADDON_GB * 25000, PANEL_ACCOUNT)
      .run();
  });
});

test.afterAll(wipe);

/**
 * Types into the box and waits for the answer to that search, not merely for
 * the click to return.
 *
 * Both waits are here because the first version of this helper had neither and
 * went green under a deliberately broken search: filling and clicking before
 * React has attached the form's submit handler does nothing at all, and the
 * test then reads the still-unfiltered first page as though it were a result.
 * It passed in 250ms while the feature it covered was switched off.
 */
async function search(page: Page, path: string, term: string) {
  await page.goto(path);
  await expect(page.locator('#main-content tbody tr').first()).toBeVisible();
  await page.locator('#ledger-q').fill(term);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`q=${encodeURIComponent(term)}`)),
    page.getByRole('button', { name: 'جست‌وجو' }).click(),
  ]);
}

test('an order is found by the number printed in its own first column', async ({ page }) => {
  await search(page, '/admin/orders', ORDER_ID);

  // The box accepts it, and says so before it is typed into: a placeholder
  // that offers only «@نام‌کاربری» is what made an admin stop trying.
  await expect(page.locator('#ledger-q')).toHaveAttribute('placeholder', /شمارهٔ سفارش/);
  const row = page.locator(`tbody tr:has-text("${ORDER_ID}")`);
  await expect(row).toHaveCount(1);
  await expect(page.locator('#main-content')).toContainText(`${fa.format(1)} سفارش`);

  // Whole, not a prefix. The id in the first cell has to be the same string the
  // customer is holding, or an admin reading it back is quoting a different
  // order number than the one they were given.
  await expect(row.locator('td').first()).toHaveText(ORDER_ID);
});

test('an add-on order says how much was bought', async ({ page }) => {
  // Reached without the search box on purpose. The fixture is the newest order
  // and the list is `ORDER BY o.id DESC`, so it is on the first page — and a
  // test that had to search for it first would go red whenever the search
  // broke, which says nothing about the column this one is about.
  await page.goto('/admin/orders');
  const row = page.locator(`tbody tr:has-text("${ORDER_ID}")`);

  // The quantity is the whole content of this order — there is no plan to name
  // — so a row that omits it says only that some volume was sold for some
  // money, which is not an answer to any question an admin has.
  await expect(row).toContainText('حجم اضافه');
  // The fourth cell and not the row: a zero discount renders «—» two columns
  // over, and asserting on the whole row would pass or fail on that instead.
  await expect(row.locator('td').nth(3)).toHaveText(`${fa.format(ADDON_GB)} گیگ`);

  // And the column is named for what it holds. «پلن» over a cell that carries
  // gigabytes is the header disagreeing with its own rows.
  await expect(page.locator('#main-content thead')).toContainText('چه چیزی');
});

test('a service is found by its panel account name', async ({ page }) => {
  await search(page, '/admin/services', PANEL_ACCOUNT);

  const row = page.locator(`tbody tr:has-text("${PANEL_ACCOUNT}")`);
  await expect(row).toHaveCount(1);
  // The point of the lookup: the panel gave a name, and the screen answers
  // with the customer behind it.
  await expect(row).toContainText('@');

  // A customer search still works — the account name is an addition to the
  // box, not a replacement for what it did.
  const owner = (await row.locator('td').first().textContent())!.trim();
  await search(page, '/admin/services', owner);
  await expect(page.locator(`tbody tr:has-text("${PANEL_ACCOUNT}")`)).toHaveCount(1);
});

/** The ledger, summed on the source side — which is the claim the cards make. */
async function ledgerTotals(kind?: string) {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr > 0), 0)::bigint AS credit,
                COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr < 0), 0)::bigint AS debit
           FROM wallet_entries
          WHERE ?1::text IS NULL OR kind = ?1`,
      )
      .bind(kind ?? null)
      .first<{ credit: number; debit: number }>();
    return { credit: Number(row?.credit ?? 0), debit: Number(row?.debit ?? 0) };
  });
}

const asToman = (irr: number) => `${fa.format(Math.trunc(Math.abs(irr) / 10))} تومان`;

test('the wallet totals are the whole ledger, and say so', async ({ page }) => {
  const all = await ledgerTotals();
  await page.goto('/admin/transactions');
  await expect(page.locator('.sidebar-link.active')).toHaveText('تراکنش‌ها');

  const cards = page.locator('.stats-grid');
  await expect(cards).toContainText('مجموع واریز');
  await expect(cards).toContainText(asToman(all.credit));
  // Magnitude under «برداشت», not a negative: the word already carries the
  // direction, and هزینه‌ها writes the same figure the same way.
  await expect(cards).toContainText('مجموع برداشت');
  await expect(cards).toContainText(asToman(all.debit));
  await expect(cards).not.toContainText(`−${asToman(all.debit)}`);

  // Nothing narrowed, so nothing to disclaim.
  await expect(page.locator('#main-content')).not.toContainText('نه روی کل دفتر');
});

test('a filtered total stops claiming to be the shop', async ({ page }) => {
  const purchases = await ledgerTotals('PURCHASE');
  // The premise. If purchases carried credits too, the «۰ واریز» this test is
  // about would never appear and it would assert nothing.
  expect(purchases.credit).toBe(0);
  expect(purchases.debit).toBeLessThan(0);

  await page.goto('/admin/transactions');
  await page.locator('#ledger-filter').selectOption('PURCHASE');

  const main = page.locator('#main-content');
  // «مجموع واریز ۰ تومان» was true of purchases and false of the shop, which
  // had taken millions in. The figure was never wrong; the word above it was.
  await expect(main).toContainText('واریزِ این جست‌وجو');
  await expect(main).not.toContainText('مجموع واریز');
  await expect(main).toContainText('خالصِ این جست‌وجو');
  await expect(main).toContainText('نه روی کل دفتر');

  // And the numbers still come from the source-side sum over everything the
  // filter matches, not over the twenty-five rows on the page.
  await expect(page.locator('.stats-grid')).toContainText(asToman(purchases.debit));

  // Clearing it puts the shop-wide claim back — the disclaimer has to be tied
  // to the request that produced the figures, not left on once shown.
  await page.locator('#ledger-filter').selectOption('');
  await expect(main).toContainText('مجموع واریز');
  await expect(main).not.toContainText('نه روی کل دفتر');
});

test('typing in the search box does not relabel figures it has not fetched yet', async ({
  page,
}) => {
  await page.goto('/admin/transactions');
  const main = page.locator('#main-content');
  await expect(main).toContainText('مجموع واریز');

  // A box being typed into has narrowed nothing. The labels describe the
  // numbers on screen, which are still the whole ledger's until a request goes
  // out and comes back.
  await page.locator('#ledger-q').fill('@nobody-here');
  await expect(main).toContainText('مجموع واریز');
  await expect(main).not.toContainText('نه روی کل دفتر');

  await page.getByRole('button', { name: 'جست‌وجو' }).click();
  await expect(main).toContainText('واریزِ این جست‌وجو');
});
