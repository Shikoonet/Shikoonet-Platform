/**
 * متن‌های ربات · آموزش، برنامه‌ها و کانال‌ها — what the bot says and shows.
 *
 * Nothing here moves money, and both screens were built carefully: the content
 * delete names the item, the keyboard reset warns that the draft goes. What
 * they share is that a mistake shows up in a customer's chat rather than on
 * this panel, so the two things asserted below are the ones with no other
 * witness.
 *
 * **A customised text is a row; a default is the absence of one.** That rule is
 * load-bearing rather than an optimisation — a shop that "saved" the shipped
 * wording unchanged would pin it, and a later release's better sentence would
 * never reach them. Nothing outside the route said so.
 *
 * **A required channel the bot cannot see is a gate that is open.** `gate.ts`
 * handles it carefully — three-valued, logged, open for one request and never
 * latched — but the only trace is a server log line, and the row on this
 * screen still reads «فعال». The panel holds no bot token and
 * `required_channels` has no column for a failed check, so this screen cannot
 * detect it. It can stop the mistake being made in silence, and that sentence
 * is what this asserts.
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

/**
 * The row is found by what an admin can actually see and type.
 *
 * The search box matches «بخشی از جمله یا توضیحش» and the table shows the
 * sentence and where it appears — the `bot_texts` key is never printed, so it
 * is not searchable either. That is consistent rather than a gap: an admin
 * editing wording does not know key names. The test therefore searches the way
 * the screen is used, and names the key only where it reads the database back.
 */
const KEY = 'SHOP_CLOSED';
const FIND_BY = 'فروشگاه موقتاً بسته است';

const wipe = () => withDb((d) => d.prepare(`DELETE FROM bot_texts WHERE key = ?1`).bind(KEY).run());

test.beforeEach(wipe);
test.afterAll(wipe);

async function storedText() {
  return withDb((d) =>
    d.prepare(`SELECT value FROM bot_texts WHERE key = ?1`).bind(KEY).first<{ value: string }>(),
  );
}

test('a customised text is stored as a row the bot will read', async ({ page }) => {
  await page.goto('/admin/texts');
  await expect(page.locator('.sidebar-link.active')).toHaveText('متن‌های ربات');

  await page.locator('#text-search').fill(FIND_BY);
  const row = page.locator(`tbody tr:has-text("${FIND_BY}")`);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'ویرایش' }).click();

  const editor = page.locator('#main-content textarea').first();
  const original = (await editor.inputValue()).trim();
  expect(original.length, 'the editor should open on the current wording').toBeGreaterThan(0);

  const changed = `${original} ✅`;
  await editor.fill(changed);
  await page.getByRole('button', { name: 'ذخیره' }).first().click();

  // Read from `bot_texts`, which is the table `botContent.ts` selects from —
  // the panel agreeing with its own response would say nothing about what the
  // customer is sent.
  await expect.poll(async () => (await storedText())?.value).toBe(changed);
});

test('saving the shipped wording unchanged removes the row instead of pinning it', async ({
  page,
}) => {
  // Start from a customised state so there is a row to lose.
  await page.goto('/admin/texts');
  await page.locator('#text-search').fill(FIND_BY);
  const row = page.locator(`tbody tr:has-text("${FIND_BY}")`);
  await row.getByRole('button', { name: 'ویرایش' }).click();

  const editor = page.locator('#main-content textarea').first();
  const original = (await editor.inputValue()).trim();
  await editor.fill(`${original} ✅`);
  await page.getByRole('button', { name: 'ذخیره' }).first().click();
  await expect.poll(async () => (await storedText()) !== null).toBe(true);

  // Now put the default back, exactly.
  await page.reload();
  await page.locator('#text-search').fill(FIND_BY);
  await page
    .locator(`tbody tr:has-text("${FIND_BY}")`)
    .getByRole('button', { name: 'ویرایش' })
    .click();
  await page.locator('#main-content textarea').first().fill(original);
  await page.getByRole('button', { name: 'ذخیره' }).first().click();

  // Absence, not a row equal to the default. A shop that pinned the shipped
  // sentence would never receive a later release's better one, and the
  // difference is invisible on screen — both states render the same text.
  await expect.poll(async () => await storedText()).toBeNull();
});

test('the channels tab says the bot has to be an admin', async ({ page }) => {
  await page.goto('/admin/content');
  await expect(page.locator('.sidebar-link.active')).toHaveText('آموزش، برنامه‌ها و کانال‌ها');
  await page.getByRole('button', { name: 'کانال اجباری' }).click();

  // The failure this warns about is the quietest one on the panel: the bot
  // cannot read a channel it is not an admin of, `gate.ts` treats that as
  // «unanswered» and lets the customer through, and the row here still says
  // «فعال». Nothing on this screen can detect it, so the sentence is the only
  // defence.
  const main = page.locator('#main-content');
  await expect(main).toContainText('ادمین');
  await expect(main).toContainText('گیت برای همه باز می‌ماند');
});

test('a required channel must be switched off before it can be deleted', async ({ page }) => {
  const title = 'e2e — کانال آزمایشی';
  await withDb(async (d) => {
    await d.prepare(`DELETE FROM required_channels WHERE title = ?1`).bind(title).run();
    await d
      .prepare(
        `INSERT INTO required_channels (title, chat_ref, join_link, active)
         VALUES (?1, '@e2e_channel_probe', 'https://t.me/e2e_channel_probe', true)`,
      )
      .bind(title)
      .run();
  });

  await page.goto('/admin/content');
  await page.getByRole('button', { name: 'کانال اجباری' }).click();
  const row = page.locator(`tbody tr:has-text("${title}")`);

  // Deleting an active channel would drop the gate for every customer between
  // one press and the admin noticing. Two presses, and the first one is
  // reversible — the delete is disabled until the row is off.
  await expect(row.getByRole('button', { name: 'حذف' })).toBeDisabled();
  await row.getByRole('button', { name: 'خاموش کن' }).click();
  await expect(row.getByRole('button', { name: 'حذف' })).toBeEnabled();

  await withDb((d) => d.prepare(`DELETE FROM required_channels WHERE title = ?1`).bind(title).run());
});
