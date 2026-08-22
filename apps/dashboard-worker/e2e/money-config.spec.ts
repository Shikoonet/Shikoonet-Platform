/**
 * حساب‌ها · بانک‌ها — the two screens that decide what the shop can recognise.
 *
 * Neither moves money on its own, which is what makes them easy to press
 * carelessly. What they decide is whether a deposit is ever *seen*: an
 * account's rows feed «امروز», the totals and matching; a card prefix decides
 * which bank a card belongs to; an SMS pattern is what lets a message be read
 * at all when no built-in parser names its bank.
 *
 * Walking them on 2026-08-22 found three presses that took something away
 * without asking. حساب‌ها was the clearest case, because the answer was
 * already in the same file: its five lifecycle transitions each name what they
 * cost and report what happened, and «غیرفعال‌کردن» — the soft-delete, the
 * strongest of the six — asked «این حساب غیرفعال شود؟» about no account in
 * particular and then said nothing.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const PREFIX = '999123';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const wipe = () =>
  withDb((d) => d.prepare(`DELETE FROM bank_card_prefixes WHERE prefix = ?1`).bind(PREFIX).run());

test.beforeEach(async () => {
  await wipe();
  await withDb((d) =>
    d
      .prepare(
        // `updated_at` here is a bigint of epoch milliseconds, not a
        // timestamptz — this table came across from the D1 side, where every
        // time column is an integer. Postgres said so rather than coercing.
        `INSERT INTO bank_card_prefixes (prefix, bank_name, updated_by, updated_at)
         VALUES (?1, 'E2E_BANK', 'e2e', (EXTRACT(EPOCH FROM now()) * 1000)::bigint)`,
      )
      .bind(PREFIX)
      .run(),
  );
});

test.afterAll(wipe);

async function activeAccount() {
  return withDb((d) =>
    d
      .prepare(
        `SELECT id, display_name FROM financial_accounts
          WHERE active = 1 ORDER BY display_name LIMIT 1`,
      )
      .first<{ id: string; display_name: string }>(),
  );
}

test('deactivating an account names it, and offers the reversible thing instead', async ({
  page,
}) => {
  const acc = await activeAccount();
  expect(acc, 'the seed should leave at least one active account').toBeTruthy();

  await page.goto('/admin/accounts');
  await expect(page.locator('.sidebar-link.active')).toHaveText('حساب‌ها');

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });

  const row = page.locator(`tbody tr:has-text("${acc!.display_name}")`).first();
  await row.getByRole('button', { name: 'غیرفعال‌کردن' }).click();
  await expect.poll(() => asked.length).toBe(1);

  expect(asked[0]).toContain(acc!.display_name);
  // `active` is a soft-delete and `status` is the lifecycle — two different
  // columns, per `packages/domain/src/accountStatus.ts`. An operator who
  // wanted «temporarily out of Today» wanted «بی‌صدا», and the dialog is
  // where that is worth saying, because both buttons sit in the same row.
  expect(asked[0]).toContain('بی‌صدا');

  const still = await withDb((d) =>
    d
      .prepare(`SELECT active FROM financial_accounts WHERE id = ?1`)
      .bind(acc!.id)
      .first<{ active: number }>(),
  );
  expect(Number(still?.active)).toBe(1);
});

test('an accepted deactivation says which account went', async ({ page }) => {
  const acc = await activeAccount();
  await page.goto('/admin/accounts');
  page.on('dialog', (d) => void d.accept());

  const row = page.locator(`tbody tr:has-text("${acc!.display_name}")`).first();
  await row.getByRole('button', { name: 'غیرفعال‌کردن' }).click();

  // Through the same banner the five lifecycle transitions already used. This
  // one wrote to none of it, so a press that worked looked like a press that
  // did nothing.
  await expect(page.locator('#main-content')).toContainText(`«${acc!.display_name}» غیرفعال شد`);

  const gone = await withDb((d) =>
    d
      .prepare(`SELECT active FROM financial_accounts WHERE id = ?1`)
      .bind(acc!.id)
      .first<{ active: number }>(),
  );
  expect(Number(gone?.active)).toBe(0);

  await withDb((d) =>
    d.prepare(`UPDATE financial_accounts SET active = 1 WHERE id = ?1`).bind(acc!.id).run(),
  );
});

test('removing a card prefix asks, and says what happens to those cards', async ({ page }) => {
  await page.goto('/admin/banks');
  await expect(page.locator('.sidebar-link.active')).toHaveText('بانک‌ها');

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });

  const row = page.locator(`tbody tr:has-text("${PREFIX}")`);
  await row.getByRole('button', { name: 'حذف' }).click();
  await expect.poll(() => asked.length).toBe(1);

  expect(asked[0]).toContain(PREFIX);
  // The longest matching prefix wins, so removal does not leave the range
  // unmapped — it silently hands those cards to a different bank or to none.
  expect(asked[0]).toContain('بانک دیگری');

  const kept = await withDb((d) =>
    d
      .prepare(`SELECT count(*)::int AS n FROM bank_card_prefixes WHERE prefix = ?1`)
      .bind(PREFIX)
      .first<{ n: number }>(),
  );
  expect(kept?.n).toBe(1);
});

test('an accepted prefix removal actually removes it', async ({ page }) => {
  await page.goto('/admin/banks');
  page.on('dialog', (d) => void d.accept());

  await page.locator(`tbody tr:has-text("${PREFIX}")`).getByRole('button', { name: 'حذف' }).click();
  await expect(page.locator(`tbody tr:has-text("${PREFIX}")`)).toHaveCount(0);

  const gone = await withDb((d) =>
    d
      .prepare(`SELECT count(*)::int AS n FROM bank_card_prefixes WHERE prefix = ?1`)
      .bind(PREFIX)
      .first<{ n: number }>(),
  );
  expect(gone?.n).toBe(0);
});
