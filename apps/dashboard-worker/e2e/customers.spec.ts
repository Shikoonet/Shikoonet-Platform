/**
 * کاربران — the one screen where the thing being changed is a person, pressed.
 *
 * Four writes live in one drawer, and walking it on 2026-08-22 found that only
 * the wallet adjust behaved like the rest of this panel. It confirms when the
 * balance would go negative, requires a written reason, previews «from → to»
 * and clears its own form. The other three fired on a single click and said
 * nothing at all afterwards: blocking a customer produced a 200, a flipped
 * badge, and not one word.
 *
 * That mattered most for the two that cost something. A block cuts a paying
 * customer off from the shop. A standing discount is not applied once — it
 * comes off **every future order** this customer places, so a 5 typed as 50
 * sells at half price until somebody notices. Neither asked.
 *
 * Everything below is read back from `users`, because the response is written
 * by the code that did the write. The confirmations are asserted in both
 * directions: the message that appears, and the row staying untouched when the
 * operator says no — a dialog nobody can decline is decoration.
 */

import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const HANDLE = 'e2e_person';
const TELEGRAM_ID = 908000771;

const fa = new Intl.NumberFormat('fa-IR');

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

/**
 * Cleaned in dependency order, and the tables are the ones the code actually
 * writes rather than the ones the names suggest.
 *
 * A message to one customer does not go to `bot_notifications` at all: the
 * route calls `queueDirectMessage`, which writes a one-recipient `broadcasts`
 * row and lets the same delivery path a bulk send uses carry it. Guessing
 * otherwise is what the first version of this file did, and Postgres answered
 * with «column "user_id" does not exist».
 *
 * `wallet_entries` is never touched here — `trg_wallet_entries_append_only`
 * refuses DELETE, so a wallet fixture would be permanent.
 */
const wipe = () =>
  withDb(async (d) => {
    await d
      .prepare(
        `DELETE FROM broadcasts WHERE id IN (
           SELECT br.broadcast_id FROM broadcast_recipients br
             JOIN users u ON u.id = br.user_id
            WHERE u.telegram_id = ?1)`,
      )
      .bind(TELEGRAM_ID)
      .run();
    await d
      .prepare(
        `DELETE FROM broadcast_recipients
          WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ?1)`,
      )
      .bind(TELEGRAM_ID)
      .run();
    await d.prepare(`DELETE FROM users WHERE telegram_id = ?1`).bind(TELEGRAM_ID).run();
  });

test.beforeEach(async () => {
  await wipe();
  await withDb((d) =>
    d
      .prepare(
        // `registered_at` is the only column here Postgres will not fill in — it is
        // NOT NULL with no default, which is the schema saying a customer without a
        // join date is not a customer.
        `INSERT INTO users (telegram_id, username, status, discount_percent, registered_at)
         VALUES (?1, ?2, 'ACTIVE', 0, now())`,
      )
      .bind(TELEGRAM_ID, HANDLE)
      .run(),
  );
});

test.afterAll(wipe);

async function person() {
  return withDb((d) =>
    d
      .prepare(`SELECT status, blocked_reason, discount_percent FROM users WHERE telegram_id = ?1`)
      .bind(TELEGRAM_ID)
      .first<{ status: string; blocked_reason: string | null; discount_percent: number }>(),
  );
}

/** Opens the drawer for the fixture customer and waits for it to be filled. */
async function open(page: Page) {
  await page.goto('/admin/customers');
  await expect(page.locator('.sidebar-link.active')).toHaveText('کاربران');
  await page.locator('#cust-q').fill(String(TELEGRAM_ID));
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`q=${TELEGRAM_ID}`)),
    page.getByRole('button', { name: 'جست‌وجو' }).click(),
  ]);
  await page
    .locator(`tbody tr:has-text("${HANDLE}")`)
    .getByRole('button', { name: 'مدیریت' })
    .click();
  await expect(page.locator('#cust-discount')).toBeVisible();
}

test('the drawer writes its numbers in the digits the rest of the panel uses', async ({ page }) => {
  await withDb((d) =>
    d
      .prepare(`UPDATE users SET discount_percent = 25 WHERE telegram_id = ?1`)
      .bind(TELEGRAM_ID)
      .run(),
  );
  await open(page);

  // «25٪» in Latin digits sat directly beside «۱ · ۹۰۰٬۰۰۰ تومان» in Persian —
  // two stats in one grid disagreeing about what a number looks like. The
  // assertion is on the exact string because that is the only way to tell them
  // apart: `25` and `۲۵` both read as twenty-five to a person describing them.
  await expect(page.locator('.stats-grid')).toContainText(`${fa.format(25)}٪`);
  await expect(page.locator('.stats-grid')).not.toContainText('25٪');
});

test('blocking asks first, and says no means no', async ({ page }) => {
  await open(page);

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'مسدود کردن' }).click();
  await expect.poll(() => asked.length).toBe(1);

  // The question names the customer and what the block does — including the
  // part an operator would otherwise get wrong. `handle.ts` runs
  // `recordReceipt` before the BLOCKED gate, so blocking somebody who has just
  // paid does not strand their money, and the dialog says so rather than
  // leaving the operator to guess.
  expect(asked[0]).toContain(`@${HANDLE}`);
  expect(asked[0]).toContain('رسید پرداختی که همین حالا باز است هنوز می‌رسد');

  // Declined, so nothing happened — asserted against `users`, not the badge.
  expect((await person())?.status).toBe('ACTIVE');
});

test('a block that is accepted lands, says so, and carries its reason', async ({ page }) => {
  await open(page);
  page.on('dialog', (d) => void d.accept());

  await page.locator('#block-reason').fill('ارسال انبوه پیام');
  await page.getByRole('button', { name: 'مسدود کردن' }).click();
  await expect(page.locator('#main-content .alert-info')).toContainText(`@${HANDLE} مسدود شد`);

  const after = await person();
  expect(after?.status).toBe('BLOCKED');
  expect(after?.blocked_reason).toBe('ارسال انبوه پیام');

  // Unblocking clears the reason rather than keeping it: a stale «چرا مسدود
  // شد» on an active account is a sentence an operator reads as current.
  await page.getByRole('button', { name: 'رفع مسدودی' }).click();
  await expect(page.locator('#main-content .alert-info')).toContainText('برداشته شد');
  const back = await person();
  expect(back?.status).toBe('ACTIVE');
  expect(back?.blocked_reason).toBeNull();
});

test('a standing discount names the old value and the new one before saving', async ({ page }) => {
  await open(page);

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await page.locator('#cust-discount').fill('50');
  await page.getByRole('button', { name: 'ذخیره' }).click();
  await expect.poll(() => asked.length).toBe(1);

  // Both numbers, because the mistake this catches is a digit: 5 typed as 50
  // looks right on its own and wrong beside «۰٪». And the sentence says the
  // discount is standing, not a one-off — that is the whole difference between
  // this control and a discount code.
  expect(asked[0]).toContain(`${fa.format(0)}٪`);
  expect(asked[0]).toContain(`${fa.format(50)}٪`);
  expect(asked[0]).toContain('از هر سفارش بعدی او کم می‌شود');

  expect((await person())?.discount_percent).toBe(0);
});

test('an accepted discount is stored as the number the bot prices from', async ({ page }) => {
  await open(page);
  page.on('dialog', (d) => void d.accept());

  await page.locator('#cust-discount').fill('15');
  await page.getByRole('button', { name: 'ذخیره' }).click();
  await expect(page.locator('#main-content .alert-info')).toContainText(
    `${fa.format(15)}٪ ذخیره شد`,
  );

  // Read back from the column `priceForUser` is fed from — the panel writing
  // its own field correctly proves nothing about the price a customer is
  // quoted; `users.discount_percent` is the one both surfaces share.
  expect((await person())?.discount_percent).toBe(15);
  await expect(page.locator('.stats-grid')).toContainText(`${fa.format(15)}٪`);
});

test('a message to a customer says it was queued, not that it was sent', async ({ page }) => {
  await open(page);

  await page.locator('#cust-message').fill('سرویس شما تمدید شد.');
  await page.getByRole('button', { name: 'فرستادن' }).click();
  // «Queued, not sent» is the route's whole contract — this process holds no
  // Telegram connection and the bot's poll loop delivers. A screen that says
  // «فرستاده شد» would have an operator telling a customer on the phone that a
  // message is already with them.
  await expect(page.locator('#main-content .alert-info')).toContainText('در صف');
  await expect(page.locator('#main-content .alert-info')).not.toContainText('فرستاده شد');

  // One recipient, carrying the Telegram id it will be delivered to. The
  // recipient row is what fixes who gets this message from the moment it is
  // written — the bot reads the list, not the customer table, so a customer
  // blocked a second later still has exactly this one row and no more.
  const queued = await withDb((d) =>
    d
      .prepare(
        `SELECT count(*)::int AS n, min(br.telegram_id)::bigint AS tg
           FROM broadcast_recipients br
           JOIN users u ON u.id = br.user_id
          WHERE u.telegram_id = ?1`,
      )
      .bind(TELEGRAM_ID)
      .first<{ n: number; tg: number }>(),
  );
  expect(queued?.n).toBe(1);
  expect(Number(queued?.tg)).toBe(TELEGRAM_ID);
});
