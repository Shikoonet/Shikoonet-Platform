/**
 * The id that ties a press to the row it wrote.
 *
 * `audit_logs.request_id` has existed since migration 0001 and every row in it
 * was NULL: the column was designed for this and nothing ever produced a
 * value. That is not cosmetic. The panel's own history is how «I pressed it
 * once and it happened twice» gets answered, and without a request id two
 * identical rows a second apart are indistinguishable from one press that was
 * retried by the browser.
 *
 * Asserted from the two ends that cannot agree by accident: the header the
 * browser actually received, and the column Postgres actually stored. A test
 * that read the id back out of the same response that carried it would be
 * asserting the panel agrees with itself.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const HANDLE = 'e2e_reqid';
const TELEGRAM_ID = 908000772;

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
    // `audit_logs` is append-only in Postgres — `trg_audit_logs_append_only`
    // refuses DELETE — so the fixture's rows stay for ever and the test reads
    // the newest one rather than the only one.
    await d.prepare(`DELETE FROM users WHERE telegram_id = ?1`).bind(TELEGRAM_ID).run();
  });

test.beforeEach(async () => {
  await wipe();
  await withDb((d) =>
    d
      .prepare(
        `INSERT INTO users (telegram_id, username, status, discount_percent, registered_at)
         VALUES (?1, ?2, 'ACTIVE', 0, now())`,
      )
      .bind(TELEGRAM_ID, HANDLE)
      .run(),
  );
});

test.afterAll(wipe);

test('the id the browser was given is the id in the audit row', async ({ page }) => {
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

  page.on('dialog', (d) => void d.accept());
  await page.locator('#block-reason').fill('e2e — request id');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/status')),
    page.getByRole('button', { name: 'مسدود کردن' }).click(),
  ]);

  const header = response.headers()['x-request-id'];
  expect(header, 'every API response should carry the id it was handled under').toBeTruthy();

  const row = await withDb((d) =>
    d
      .prepare(
        `SELECT a.request_id
           FROM audit_logs a
           JOIN users u ON u.id::text = a.entity_id
          WHERE u.telegram_id = ?1 AND a.action = 'customer.blocked'
          ORDER BY a.created_at DESC
          LIMIT 1`,
      )
      .bind(TELEGRAM_ID)
      .first<{ request_id: string | null }>(),
  );
  expect(row?.request_id).toBe(header);
});
