/**
 * ارسال گروهی — the two actions that reach every customer at once, pressed.
 *
 * `panel.spec.ts` already walks the price half of this screen. What no browser
 * had touched is the half that moves money: type an amount, read the total on
 * the confirmation, press it, and see the ledger.
 *
 * The confirmation total is the assertion that matters most here. It is the
 * only thing on the screen that catches a typed extra zero — «۵۰٬۰۰۰ تومان»
 * and «۵٬۰۰۰ تومان» look alike at a glance, and their totals over eleven
 * thousand customers do not. Asserting it against a number this file computes
 * rather than against what the page rendered is the point: a total built from
 * the same state as the fields would agree with a typo.
 *
 * The wallet is read from the database. The response body is written by the
 * code that did the write, so it can be wrong in the same direction.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const PER_PERSON_TOMAN = 3_000;

async function db<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>): Promise<T> {
  const { db: d, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(d);
  } finally {
    await pool.end();
  }
}

const activeCustomers = () =>
  db(async (d) =>
    Number(
      (
        await d
          .prepare(`SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`)
          .first<{ n: number }>()
      )?.n ?? 0,
    ),
  );

/**
 * The newest bulk batch, on its own.
 *
 * Grouped by the batch inside the key — `bulk:<batch>:<user>` — rather than
 * counted across the whole ledger. The first draft asserted that
 * `count(DISTINCT user_id)` grew by the reach, which is only true the first
 * time a shop is credited: the second batch adds a row per customer and no new
 * customer. Once per customer *in this batch* is the actual claim.
 */
const newestBatch = () =>
  db(async (d) => {
    const row = await d
      .prepare(
        `SELECT count(*)::int AS rows, count(DISTINCT user_id)::int AS users,
                COALESCE(SUM(amount_irr), 0)::bigint AS total
           FROM wallet_entries
          WHERE idempotency_key LIKE 'bulk:%'
            AND split_part(idempotency_key, ':', 2) = (
              SELECT split_part(idempotency_key, ':', 2)
                FROM wallet_entries
               WHERE idempotency_key LIKE 'bulk:%'
               ORDER BY id DESC LIMIT 1)`,
      )
      .first<{ rows: number; users: number; total: number }>();
    return {
      rows: Number(row?.rows ?? 0),
      users: Number(row?.users ?? 0),
      total: Number(row?.total ?? 0),
    };
  });

test('the confirmation multiplies before the money moves, and the ledger agrees after', async ({
  page,
}) => {
  const reach = await activeCustomers();
  expect(reach).toBeGreaterThan(0);

  await page.goto('/admin/bulk');
  await expect(page.locator('.sidebar-link.active')).toHaveText('ارسال گروهی');

  await page.locator('#bulk-amount').fill(String(PER_PERSON_TOMAN));
  await page.getByRole('button', { name: 'ادامه' }).first().click();

  const confirm = page.getByRole('group', { name: 'شارژ گروهی تایید شود؟' });
  await expect(confirm).toBeVisible();
  // Computed here, not read off the same state the fields came from.
  const fa = new Intl.NumberFormat('fa-IR');
  await expect(confirm).toContainText(`${fa.format(reach)}`);
  await expect(confirm).toContainText(`${fa.format(PER_PERSON_TOMAN * reach)} تومان`);
  await expect(confirm).toContainText('برگشت‌پذیر نیست');

  await confirm.getByRole('button', { name: 'تایید' }).click();
  await expect(page.locator('#main-content')).toContainText(
    `کیف پول ${fa.format(reach)} مشتری شارژ شد.`,
  );

  const batch = await newestBatch();
  // One entry per customer inside this batch, each customer once, and Toman
  // converted exactly once on the way in.
  expect(batch.rows).toBe(reach);
  expect(batch.users).toBe(reach);
  expect(batch.total).toBe(PER_PERSON_TOMAN * 10 * reach);
});

test('the screen says what went out last, so nobody sends it twice by hand', async ({ page }) => {
  // The guard the idempotency key cannot be: a fresh batch is a legitimate new
  // charge, so the only thing standing between an operator and a second one is
  // knowing that the first happened. Nothing said so until 2026-08-22.
  await page.goto('/admin/bulk');
  const last = page.getByText(/^آخرین بار: شارژ/);
  await expect(last).toBeVisible();

  const fa = new Intl.NumberFormat('fa-IR');
  await expect(last).toContainText(`${fa.format(PER_PERSON_TOMAN)} تومان`);
  // Who, as well as what. A shop with two admins needs the name more than the
  // number.
  await expect(last).toContainText('@');
  // Persian digits, like every other number on this panel.
  await expect(last).not.toHaveText(/[0-9]/);
});

test('a broadcast is queued for the bot and sent by nobody here', async ({ page }) => {
  const reach = await activeCustomers();

  await page.goto('/admin/bulk');
  await page.locator('#bulk-body').fill('پیام آزمایشی از محیط شبیه‌سازی');
  await page.getByRole('button', { name: 'ادامه' }).nth(1).click();

  const confirm = page.getByRole('group', { name: 'پیام همگانی فرستاده شود؟' });
  await expect(confirm).toBeVisible();
  // The text itself is shown back before it goes to everyone.
  await expect(confirm).toContainText('پیام آزمایشی از محیط شبیه‌سازی');
  await confirm.getByRole('button', { name: 'تایید' }).click();

  await expect(page.locator('#main-content')).toContainText('در صف قرار گرفت');

  // The newest broadcast only. `broadcast_recipients` keeps every send, so a
  // count over the whole table grows with the suite and would have made this
  // pass or fail depending on how many broadcasts ran before it.
  const rows = await db(async (d) =>
    d
      .prepare(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE status = 'PENDING')::int AS pending
           FROM broadcast_recipients
          WHERE broadcast_id = (SELECT id FROM broadcasts
                                 ORDER BY created_at DESC LIMIT 1)`,
      )
      .first<{ n: number; pending: number }>(),
  );
  expect(Number(rows?.n)).toBe(reach);
  // Every one still PENDING: this screen writes the list down and the bot's
  // poll loop is what sends. A route that sent inline would leave nothing to
  // resume from, and the paragraph on the card promises exactly this.
  expect(Number(rows?.pending)).toBe(reach);
});
