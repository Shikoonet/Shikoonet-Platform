/**
 * An admin edits what the bot says, and the bot's own source of truth changes.
 *
 * Every assertion about the effect of the edit is made against Postgres, not
 * against the screen that made it. A spec that clicks «ذخیره», sees the row
 * turn into «تغییر داده شده» and stops has proved that React re-rendered its
 * own optimistic state — the exact shape of test this project has been bitten
 * by before: agreeing with the code under test rather than with something
 * outside it.
 *
 * The route layer is already covered by `test/bot-content.test.ts`. What only a
 * browser adds is that the SPA is wired to that route at all: served from the
 * right mount, calling the right path, sending the right body. `/admin` is a
 * separate Vite build behind a separate Access audience, and a mount that
 * regresses looks like a blank page that no unit test can see.
 */

import { test, expect } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const DB = process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo';

/**
 * The one text this spec owns.
 *
 * Picked for two properties, not at random: it declares no placeholders, so the
 * server's placeholder check cannot reject an edit for a reason unrelated to
 * what is being tested, and its default sentence is distinctive enough to find
 * in a table of roughly two hundred rows.
 */
const KEY = 'HELP_EMPTY';
const DEFAULT_TEXT = 'هنوز مطلب آموزشی ثبت نشده است.';
/**
 * The row's own description, from the registry's `hint`.
 *
 * The row is found by this rather than by the sentence it holds, because the
 * sentence is the thing being changed: clicking «ویرایش» swaps the text for a
 * textarea and the filter stops matching mid-test. The hint stays put through
 * edit, save and reset, which is exactly what an anchor has to do.
 */
const ROW_HINT = 'وقتی مطلب آموزشی نیست';

/** Postgres through the project's own adapter, so no second driver is added. */
async function withDb<T>(fn: (db: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: DB });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

/** The stored override, or null while the bot is still using its default. */
function storedValue(): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db
      .prepare('SELECT value FROM bot_texts WHERE key = ?1')
      .bind(KEY)
      .first<{ value: string }>();
    return row?.value ?? null;
  });
}

test.beforeEach(async () => {
  // An override left over from a failed run would make the "starts as default"
  // assertion pass or fail for a reason unrelated to this test. Cleared before
  // rather than after, so a failure is still there to look at.
  await withDb((db) => db.prepare('DELETE FROM bot_texts WHERE key = ?1').bind(KEY).run());
});

async function openBotTexts(page: import('@playwright/test').Page) {
  await page.goto('/admin/');
  await page.getByRole('button', { name: 'متن‌های ربات' }).click();
}

test('an edited bot text reaches the database, and comes back from it', async ({ page }) => {
  expect(await storedValue()).toBeNull();

  await openBotTexts(page);
  // Narrow to one row before touching anything: «ویرایش» is on every row.
  // Searched by the hint, not by the sentence. The sentence is what this test
  // changes, and a filter holding the old one drops the row out of the table
  // the moment it is saved — which looks exactly like the save having failed.
  await page.locator('#text-search').fill(ROW_HINT);
  const row = page.locator('tbody tr').filter({ hasText: ROW_HINT }).first();
  await expect(row).toContainText(DEFAULT_TEXT);
  await row.getByRole('button', { name: 'ویرایش' }).click();

  const written = 'هنوز مطلبی نگذاشته‌ایم — به‌زودی.';
  await row.locator('textarea').fill(written);
  await row.getByRole('button', { name: 'ذخیره' }).click();

  // The screen agreeing with itself is necessary but not sufficient, so it is
  // asserted and then checked against the database underneath it.
  await expect(row.getByText('تغییر داده شده')).toBeVisible();

  const stored = await withDb((db) =>
    db
      .prepare('SELECT value, updated_by FROM bot_texts WHERE key = ?1')
      .bind(KEY)
      .first<{ value: string; updated_by: string | null }>(),
  );
  expect(stored?.value).toBe(written);
  // Who changed it is part of the record, not decoration: every other admin
  // write here is attributable, and this one goes through the same identity.
  expect(stored?.updated_by).toBeTruthy();

  // And it renders from the server rather than from React's memory.
  await page.reload();
  await page.getByRole('button', { name: 'متن‌های ربات' }).click();
  await page.locator('#text-search').fill(ROW_HINT);
  await expect(page.locator('tbody tr').filter({ hasText: ROW_HINT })).toContainText(written);
});

test('«پیش‌فرض» deletes the override rather than storing the default', async ({ page }) => {
  // The difference is invisible on screen and matters later: storing today's
  // default would pin this text to this release, and every future improvement
  // to the bot's own wording would silently stop reaching this shop.
  await withDb((db) =>
    db
      .prepare(
        `INSERT INTO bot_texts (key, value, updated_by) VALUES (?1, ?2, 'e2e')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(KEY, 'یک متن موقت، فقط برای همین تست')
      .run(),
  );
  expect(await storedValue()).not.toBeNull();

  await openBotTexts(page);
  await page.locator('#text-search').fill(ROW_HINT);
  const row = page.locator('tbody tr').filter({ hasText: ROW_HINT }).first();
  await row.getByRole('button', { name: 'پیش‌فرض', exact: true }).click();

  await expect
    .poll(storedValue, { message: 'the override row should be gone, not rewritten' })
    .toBeNull();
});
