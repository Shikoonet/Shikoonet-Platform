/**
 * هزینه‌ها و تعدیل‌ها — the shop's own ledger, pressed.
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
          `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at)
           VALUES (?1, ?2, 'e2e@shikoo.local', now())`,
        )
        .bind(irr, NOTE)
        .run();
    }
  });
});

test.afterAll(async () => {
  await withDb((d) => d.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE 'e2e — %'`).run());
});

/** The whole ledger, summed on the source side — which is the claim. */
async function ledger() {
  return withDb(async (d) => {
    const row = await d
      .prepare(
        `SELECT COALESCE(SUM(-amount_irr) FILTER (WHERE amount_irr < 0), 0)::bigint AS spent,
                COALESCE(SUM(amount_irr)  FILTER (WHERE amount_irr > 0), 0)::bigint AS earned,
                COALESCE(SUM(amount_irr), 0)::bigint                               AS net,
                count(*)::int                                                      AS rows
           FROM revenue_adjustments`,
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
  await expect(page.locator('.sidebar-link.active')).toHaveText('هزینه‌ها و تعدیل‌ها');

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

test('deleting says which way the ledger will move', async ({ page }) => {
  // The dialog strips the sign from the figure for readability, so without a
  // word for the direction it reads identically for both kinds — while they do
  // opposite things to revenue. Added 2026-08-22 after pressing it.
  await page.goto('/admin/expenses');

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });

  // The credit row, whose deletion LOWERS the net.
  await page
    .locator(`#main-content table >> nth=1 >> tbody tr:has-text("+${fa.format(400_000)}")`)
    .getByRole('button', { name: 'حذف' })
    .click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('بستانکاریِ');
  expect(asked[0]).toContain('خالص پایین می‌آید');

  // And an expense, whose deletion RAISES it.
  await page
    .locator(`#main-content table >> nth=1 >> tbody tr:has-text("−${fa.format(199_999)}")`)
    .first()
    .getByRole('button', { name: 'حذف' })
    .click();
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]).toContain('هزینهٔ');
  expect(asked[1]).toContain('خالص بالا می‌رود');

  // Dismissed both times, so nothing was removed.
  expect((await ledger()).rows).toBeGreaterThanOrEqual(SEEDED_IRR.length + 1);
});

test('a deleted row is gone from the ledger and kept in the log', async ({ page }) => {
  const before = await ledger();

  await page.goto('/admin/expenses');
  page.once('dialog', (d) => void d.accept());
  await page
    .locator(`#main-content table >> nth=1 >> tbody tr:has-text("+${fa.format(400_000)}")`)
    .getByRole('button', { name: 'حذف' })
    .click();
  await expect(page.locator('#main-content')).toContainText('حذف شد');

  const after = await ledger();
  expect(after.rows).toBe(before.rows - 1);
  expect(after.net).toBe(before.net - CREDIT_IRR);

  // Recoverable: the row that is gone is written down before it goes, with the
  // amount and the note, so a mistaken delete is a re-entry rather than a loss.
  const logged = await withDb((d) =>
    d
      .prepare(
        `SELECT before_json::text AS b FROM audit_logs
          WHERE action = 'revenue_adjustment.deleted'
          ORDER BY id DESC LIMIT 1`,
      )
      .first<{ b: string }>(),
  );
  expect(logged?.b).toContain(String(CREDIT_IRR));
  expect(logged?.b).toContain(NOTE);
});
