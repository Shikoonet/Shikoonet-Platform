/**
 * هزینه‌ها — the shop's own ledger, pressed.
 *
 * Everything on this screen lands on the shop's profit, and the totals at the
 * top are derived rather than stored, exactly like a wallet balance. That makes
 * one question worth more than the rest: **where does Rial become Toman?**
 *
 * Summing in Rial and converting once gives 649,999 Toman for the rows below.
 * Converting each row and then adding gives 649,998. Both look right on screen;
 * only the first is right, and the difference grows with the number of rows.
 * The whole money rule of this repository is that the sum happens on the source
 * side, so this file asserts the number that proves it — with amounts chosen so
 * the two answers cannot be equal.
 *
 * Rows are made through the database rather than the form where the awkward
 * figures are needed: the form takes Toman and multiplies by ten, so it cannot
 * produce a Rial value that does not divide by ten. Legacy imports can, which
 * is why the case matters at all.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const NOTE = 'e2e — ردیف آزمایشی هزینه';

/**
 * Two expenses that each end in 5 Rial, so per-row truncation loses a Toman the
 * source-side sum keeps.
 */
const SEEDED_IRR = [-1_999_995, -1_999_995, -2_500_000];
const CREDIT_IRR = 4_000_000;

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const fa = new Intl.NumberFormat('fa-IR');

/**
 * Rial to Toman the way the panel writes it — toward zero, once, at the end,
 * and with the sign as its own character.
 *
 * The magnitude is always formatted from the absolute value. `Intl` puts an
 * invisible left-to-right mark before a negative number and the summary cell
 * does not: it renders a bare `−` and then the absolute figure. Feeding a
 * negative straight to `Intl` here produced an expected string that differed
 * from the screen by one character nobody can see, which is a worse test
 * failure than a wrong number.
 */
const asToman = (irr: number) => `${fa.format(Math.trunc(Math.abs(irr) / 10))} تومان`;

test.beforeAll(async () => {
  await withDb(async (d) => {
    await d.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE 'e2e — %'`).run();
    for (const irr of [...SEEDED_IRR, CREDIT_IRR]) {
      await d
        .prepare(
          `INSERT INTO revenue_adjustments
             (amount_irr, note, created_by, created_at, kind, spent_on)
           VALUES (?1, ?2, 'e2e@shikoo.local', now(),
                   CASE WHEN ?1 < 0 THEN 'EXPENSE' ELSE 'MANUAL_INCOME' END,
                   (now() AT TIME ZONE 'Asia/Tehran')::date)`,
        )
        .bind(irr, NOTE)
        .run();
    }
  });
});

test.afterAll(async () => {
  await withDb((d) => d.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE 'e2e — %'`).run());
});

/**
 * The whole ledger, summed on the source side — which is the claim.
 *
 * `shop_books` and not `revenue_adjustments`: a voided row stays in the table
 * for `verify.ts` and leaves the view for the panel, so the view is what the
 * screen's totals have to agree with.
 */
async function ledger() {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT COALESCE(SUM(-amount_irr) FILTER (WHERE amount_irr < 0), 0)::bigint AS spent,
                COALESCE(SUM(amount_irr)  FILTER (WHERE amount_irr > 0), 0)::bigint AS earned,
                COALESCE(SUM(amount_irr), 0)::bigint                               AS net,
                count(*)::int                                                      AS rows
           FROM shop_books`,
      )
      .first<{ spent: number; earned: number; net: number; rows: number }>();
    return {
      spent: Number(row?.spent ?? 0),
      earned: Number(row?.earned ?? 0),
      net: Number(row?.net ?? 0),
      rows: Number(row?.rows ?? 0),
    };
  });
}

test('the totals are summed in Rial and converted once, not the other way round', async ({
  page,
}) => {
  const l = await ledger();

  // The premise of the test. If these were equal the assertion below would pass
  // for a page that converts per row, and prove nothing.
  const perRow = SEEDED_IRR.reduce((a, irr) => a + Math.trunc(-irr / 10), 0);
  const sourceSide = Math.trunc(SEEDED_IRR.reduce((a, irr) => a - irr, 0) / 10);
  expect(sourceSide).not.toBe(perRow);

  await page.goto('/admin/expenses');
  await expect(page.locator('.sidebar-link.active')).toHaveText('هزینه‌ها');

  const summary = page.locator('#main-content table').first();
  await expect(summary).toContainText(asToman(l.spent));
  await expect(summary).toContainText(asToman(l.earned));
  // Sign and magnitude asserted together: a net that lost its minus reads as a
  // profitable month.
  await expect(summary).toContainText(`${l.net < 0 ? '−' : '+'}${asToman(l.net)}`);
});

test('a row records who wrote it, and the amount keeps its direction', async ({ page }) => {
  await page.goto('/admin/expenses');
  const list = page.locator('#main-content table').nth(1);

  // An expense is negative on the screen and a credit is positive. They sit in
  // the same column, and a reader who cannot tell them apart at a glance is
  // reading a ledger that says nothing.
  await expect(list).toContainText(`−${fa.format(199_999)} تومان`);
  await expect(list).toContainText(`+${fa.format(400_000)} تومان`);
  await expect(list).toContainText('e2e@shikoo.local');
});

/**
 * Voiding, which replaced deleting on 2026-08-30.
 *
 * The directional sentence is kept verbatim from the delete dialog it
 * replaces: it was added after somebody pressed that button, and it is the one
 * part of this that says what will happen to the figure on the screen behind
 * it. What is new is that a reason is required — which is the whole difference
 * between a line that is gone and a line that is explained.
 */
test('voiding says which way the ledger will move, and demands a reason', async ({ page }) => {
  await page.goto('/admin/expenses');
  await page.getByRole('button', { name: 'ابطال' }).first().click();

  const panel = page.locator('.card', { hasText: 'ابطال ردیف' });
  await expect(panel).toContainText('در دفتر می‌ماند');
  await expect(panel).toContainText(/بالا می‌رود|پایین می‌آید/);

  // The button is refused until there is a reason to record.
  await expect(panel.getByRole('button', { name: 'بله، باطل کن' })).toBeDisabled();
  await panel.locator('#void-reason').fill('e2e — دو بار ثبت شده بود');
  await expect(panel.getByRole('button', { name: 'بله، باطل کن' })).toBeEnabled();
});

test('a voided row leaves every total, stays on screen, and is kept in the log', async ({
  page,
}) => {
  const before = await ledger();

  await page.goto('/admin/expenses');
  const row = page.locator('tbody tr', { hasText: NOTE }).first();
  const amount = await row.locator('td').nth(4).innerText();
  await row.getByRole('button', { name: 'ابطال' }).click();

  const panel = page.locator('.card', { hasText: 'ابطال ردیف' });
  await panel.locator('#void-reason').fill('e2e — باطل شد');
  await panel.getByRole('button', { name: 'بله، باطل کن' }).click();
  await expect(page.locator('#main-content')).toContainText('باطل شد');

  // The books moved...
  const after = await ledger();
  expect(after.rows).toBe(before.rows - 1);

  // ...and the row did not go anywhere. This is the half a delete could never
  // do, and the half `verify.ts` depends on: it counts rows in the TABLE
  // against the legacy log, so a deletion made that check red for ever.
  const stillThere = await withDb((d) =>
    d
      .prepare(
        `SELECT count(*)::int AS n FROM revenue_adjustments
          WHERE note LIKE 'e2e — %' AND voided_at IS NOT NULL AND void_reason = ?1`,
      )
      .bind('e2e — باطل شد')
      .first<{ n: number }>(),
  );
  expect(Number(stillThere?.n)).toBe(1);

  // And it is visible again the moment somebody asks for it, struck through
  // rather than absent — the difference between «this did not happen» and
  // «this happened and was cancelled».
  await page.selectOption('#adj-voided', 'only');
  await expect(page.locator('tbody tr', { hasText: 'باطل' }).first()).toContainText(amount);
});

/**
 * «تفکیک» — the breakdown, and the arithmetic that makes it checkable.
 *
 * Sam's complaint was that the screen could not say what the money went on.
 * The assertion is not that a category exists but that filtering to one makes
 * the headline that category's own total: two numbers on one screen that
 * disagree is how an admin stops using both.
 */
test('filtering to a category makes the headline that category\'s own total', async ({ page }) => {
  await page.goto('/admin/expenses');

  const breakdown = page.locator('.card', { hasText: 'تفکیک هزینه‌ها' });
  await expect(breakdown).toBeVisible();

  const firstCategory = breakdown.locator('tbody tr').first();
  const categoryAmount = await firstCategory.locator('td').nth(2).innerText();
  await firstCategory.click();

  // The first row of the totals table is «در این فیلتر».
  const inFilter = page.locator('.card').first().locator('tbody tr').first();
  await expect(inFilter).toContainText(categoryAmount);
});
