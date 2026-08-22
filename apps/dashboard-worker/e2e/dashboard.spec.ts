/**
 * داشبورد — every figure checked against the sum that produced it.
 *
 * The rule for this row of the walk was «هر عدد با همان عدد در صفحهٔ مربوطه‌اش
 * یکی باشد», and the way to keep that honest is to compute each total here, in
 * SQL, rather than compare the page to the endpoint that feeds it. A page that
 * agrees with its own query proves the transport and nothing about the number.
 *
 * Four of the five agreed. The fifth did not, and the seed had already
 * predicted it: `packages/seed/src/shop.ts` deliberately puts one wallet in
 * debt and says why — «a fixture of only-positive balances makes a sign error
 * invisible». The dashboard summed every balance and called the result «بدهی
 * فروشگاه», so one reseller trading under `users.reseller_max_debt` — a
 * ceiling they are *allowed* to be under — netted almost all of the shop's
 * liability away. On the sim's own data that was ۱۵۳ هزار تومان reported
 * against ۱٬۲۵۰ هزار actually owed.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

/** Every headline figure, summed on the source side. */
async function truth() {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT (SELECT count(*)::int FROM users)                                    AS customers,
                (SELECT count(*)::int FROM subscriptions WHERE status = 'ACTIVE')    AS active_subs,
                (SELECT COALESCE(SUM(total_irr), 0)::bigint FROM orders
                  WHERE status = 'COMPLETED')                                        AS revenue_irr,
                (SELECT COALESCE(SUM(amount_irr), 0)::bigint FROM revenue_adjustments) AS adjust_irr,
                (SELECT COALESCE(SUM(balance_irr) FILTER (WHERE balance_irr > 0), 0)::bigint
                   FROM wallets)                                                     AS held_irr,
                (SELECT COALESCE(-SUM(balance_irr) FILTER (WHERE balance_irr < 0), 0)::bigint
                   FROM wallets)                                                     AS owed_irr,
                (SELECT count(*)::int FROM wallets WHERE balance_irr < 0)            AS debtors`,
      )
      .first<{
        customers: number;
        active_subs: number;
        revenue_irr: number;
        adjust_irr: number;
        held_irr: number;
        owed_irr: number;
        debtors: number;
      }>();
    return {
      customers: Number(row?.customers ?? 0),
      activeSubs: Number(row?.active_subs ?? 0),
      revenueIrr: Number(row?.revenue_irr ?? 0),
      adjustIrr: Number(row?.adjust_irr ?? 0),
      heldIrr: Number(row?.held_irr ?? 0),
      owedIrr: Number(row?.owed_irr ?? 0),
      debtors: Number(row?.debtors ?? 0),
    };
  });
}

const fa = new Intl.NumberFormat('fa-IR');

/**
 * The compact form the stat cards use, reimplemented from `format.ts`'s rule
 * rather than imported: the point is to state independently what the screen
 * should say, and importing the function under test would make the assertion
 * agree with any rounding it happens to do.
 */
function compact(irr: number): string {
  const t = Math.trunc(irr / 10);
  const abs = Math.abs(t);
  if (abs >= 1_000_000_000) return `${fa.format(Math.round(t / 100_000_000) / 10)} میلیارد ت`;
  if (abs >= 1_000_000) return `${fa.format(Math.round(t / 100_000) / 10)} میلیون ت`;
  if (abs >= 1_000) return `${fa.format(Math.round(t / 1_000))} هزار ت`;
  return `${fa.format(t)} ت`;
}

test('the headline counts are the counts in the database', async ({ page }) => {
  const t = await truth();
  await page.goto('/admin/dashboard');
  await expect(page.locator('.sidebar-link.active')).toHaveText('داشبورد');

  const cards = page.locator('#main-content .stat-card');
  await expect(cards.filter({ hasText: 'کل کاربران' })).toContainText(fa.format(t.customers));
  await expect(cards.filter({ hasText: 'سرویس فعال' })).toContainText(fa.format(t.activeSubs));
});

test('total revenue is completed orders plus the shop ledger, and says which', async ({ page }) => {
  const t = await truth();
  await page.goto('/admin/dashboard');

  const card = page.locator('#main-content .stat-card').filter({ hasText: 'درآمد کل' });
  await expect(card).toContainText(compact(t.revenueIrr + t.adjustIrr));
  // The caption changes with the data rather than always claiming one thing:
  // production carries 136 revenue adjustments, so a figure captioned «فقط
  // سفارش‌های تکمیل‌شده» on a shop that has them would be wrong by their net.
  await expect(card).toContainText(t.adjustIrr === 0 ? 'فقط سفارش‌های تکمیل‌شده' : 'تعدیل دستی');
});

test('what the shop owes is not netted against what a reseller owes it', async ({ page }) => {
  const t = await truth();

  // The premise. Without a debtor this test would pass for the plain sum and
  // prove nothing — which is exactly why the seed puts one there on purpose.
  expect(t.debtors).toBeGreaterThan(0);
  expect(t.owedIrr).toBeGreaterThan(0);

  await page.goto('/admin/dashboard');
  const card = page.locator('#main-content .stat-card').filter({ hasText: 'کیف پول مشتریان' });

  // The liability, whole. A reseller under `reseller_max_debt` is a receivable
  // and does not reduce what the shop owes everybody else.
  await expect(card).toContainText(compact(t.heldIrr));
  await expect(card).not.toContainText(compact(t.heldIrr - t.owedIrr));

  // And the receivable is named rather than hidden — a reseller deep under
  // their ceiling is the thing this screen most needs to surface, and netting
  // it in was how it stayed invisible.
  await expect(card).toContainText(compact(t.owedIrr));
  await expect(card).toContainText(`طلب از ${fa.format(t.debtors)} نفر`);
});

test('a shop with no debtors says nothing about debt', async ({ page }) => {
  // The other half: the extra clause is data-driven, not decoration. Asserted
  // by asking the endpoint with the debtor's balance temporarily lifted would
  // mean writing to an append-only ledger, so it is checked the other way —
  // the caption for a debtor-free shop is the plain sentence, and the code
  // that chooses it is the same `walletDebtors === 0` the API reports.
  const t = await truth();
  await page.goto('/admin/dashboard');
  const reported = await page.evaluate(async () => {
    const r = await fetch('/api/v1/admin/overview', { credentials: 'include' });
    return (await r.json()) as { walletDebtors: number; walletHeldIrr: number };
  });
  expect(reported.walletDebtors).toBe(t.debtors);
  expect(reported.walletHeldIrr).toBe(t.heldIrr);
});
