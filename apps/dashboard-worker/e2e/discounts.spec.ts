/**
 * کدهای تخفیف — money coming off a price, pressed.
 *
 * Two things are asserted here that a route test cannot see.
 *
 * The conversion. The form asks for Toman and the column is Rial, and the only
 * proof that the multiply happens exactly once is reading the row back.
 *
 * The expiry. There was no field for it until 2026-08-22 — the route had
 * accepted `expiresAt` the whole time and the form simply never sent one, so
 * every code made from this panel lived for ever while all 33 codes in the
 * production dump carry an expiry. The admin could not reproduce what they
 * already do. What this asserts is not that a date arrives, but that it arrives
 * as the RIGHT instant: the start of the following Tehran day, so a code «until
 * the first» works all of the first.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const PCT = 'E2EPCT';
const FIX = 'E2EFIX';
const DATED = 'E2EDATE';
const EXPIRES_ON = '2026-09-01';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

async function codeRow(code: string) {
  return withDb((d) =>
    d
      .prepare(
        `SELECT kind, amount_irr::bigint AS amount_irr, percent::text AS percent,
                max_uses, applies_to, expires_at
           FROM discount_codes WHERE lower(code) = lower(?1)`,
      )
      .bind(code)
      .first<{
        kind: string;
        amount_irr: number | null;
        percent: string | null;
        max_uses: number | null;
        applies_to: string;
        expires_at: string | null;
      }>(),
  );
}

const wipe = () =>
  withDb((d) =>
    d
      .prepare(`DELETE FROM discount_codes WHERE lower(code) IN (lower(?1), lower(?2), lower(?3))`)
      .bind(PCT, FIX, DATED)
      .run(),
  );

test.beforeAll(wipe);
test.afterAll(wipe);

async function create(
  page: import('@playwright/test').Page,
  fill: (form: import('@playwright/test').Locator) => Promise<void>,
) {
  await page.goto('/admin/discounts');
  await expect(page.locator('.sidebar-link.active')).toHaveText('کدهای تخفیف');
  await page.getByRole('button', { name: 'کد جدید', exact: true }).click();
  const form = page.locator('#main-content');
  await fill(form);
  await form.getByRole('button', { name: 'ساخت' }).click();
}

test('a percentage code is stored as a percentage, with its ceiling', async ({ page }) => {
  await create(page, async (form) => {
    await form.locator('#new-code').fill(PCT);
    await form.locator('#new-percent').fill('15');
    await form.locator('#new-max').fill('3');
  });

  const row = await codeRow(PCT);
  expect(row?.kind).toBe('PERCENT_OFF');
  expect(Number(row?.percent)).toBe(15);
  expect(row?.max_uses).toBe(3);
  // A percentage code must not also carry an amount: the bot picks its branch
  // on `kind`, and a stray amount is a discount waiting to be applied twice.
  expect(row?.amount_irr).toBeNull();
});

test('a fixed code multiplies Toman into Rial exactly once', async ({ page }) => {
  await create(page, async (form) => {
    await form.locator('#new-code').fill(FIX);
    await form.locator('#new-kind').selectOption('AMOUNT_OFF');
    await form.locator('#new-amount').fill('25000');
    await form.locator('#new-max').fill('1');
  });

  const row = await codeRow(FIX);
  expect(row?.kind).toBe('AMOUNT_OFF');
  expect(Number(row?.amount_irr)).toBe(250_000);
  expect(row?.percent).toBeNull();
});

test('an expiry is stored as the first instant of the next Tehran day', async ({ page }) => {
  await create(page, async (form) => {
    await form.locator('#new-code').fill(DATED);
    await form.locator('#new-percent').fill('10');
    await form.locator('#new-expires').fill(EXPIRES_ON);
  });

  const row = await codeRow(DATED);
  expect(row?.expires_at).not.toBeNull();

  // Read back through Tehran, which is the only place the answer is legible.
  // The bot refuses on `expires_at <= now`, so midnight of the NEXT day is what
  // makes a code «until the first» work all of the first.
  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(row!.expires_at!));
  expect(shown).toBe('2026-09-02, 00:00');
});

test('the list says what each code is, in the digits the panel uses', async ({ page }) => {
  await page.goto('/admin/discounts');
  const table = page.locator('#main-content table');
  const fa = new Intl.NumberFormat('fa-IR');

  const pct = table.locator(`tr:has-text("${PCT}")`);
  await expect(pct).toContainText('درصدی');
  await expect(pct).toContainText(`${fa.format(15)}٪`);
  // Used against the ceiling, not a bare number: «۰» alone says nothing about
  // how many are left.
  await expect(pct).toContainText(`${fa.format(0)} از ${fa.format(3)}`);

  // A code with no expiry says so rather than showing an empty cell, and one
  // with an expiry shows the date — the column existed before anything could
  // put a date in it.
  await expect(table.locator(`tr:has-text("${FIX}")`)).toContainText('بدون انقضا');
  await expect(table.locator(`tr:has-text("${DATED}")`)).not.toContainText('بدون انقضا');
});
