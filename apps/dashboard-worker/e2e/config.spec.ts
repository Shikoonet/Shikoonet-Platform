/**
 * مدیریت پنل‌ها · تنظیمات · لیست درخواست‌ها — the configuration screens, pressed.
 *
 * Sections eight to twelve of the walk. Most of what was pressed here turned
 * out to be sound, and that is worth writing down as plainly as a defect: the
 * settings screen really does keep a gateway credential off the wire, the
 * reseller list really can decide an application, and دسترسی‌ها really does
 * refuse to let an operator delete themselves. What none of it had was
 * anything asserting it from a browser, which is the difference between a
 * guarantee and a comment.
 *
 * One real defect came out of it, on مدیریت پنل‌ها, and it is the one the
 * plan predicted for that row: «`base_url` غلط یعنی هیچ تحویلی انجام نمی‌شود».
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * A value shaped like the thing this is actually protecting.
 *
 * `migrateSettings` copies `PaySetting` in verbatim, and that table carries
 * `merchant_zarinpal`, `apinowpayment`, `walletaddress` and five more — live
 * gateway credentials in plaintext. The unit suite proves `isSecretKey()`
 * matches those names, which is a test of a regular expression against a list
 * of strings; it says nothing about whether the value reaches a browser tab.
 */
const SECRET_KEY = 'merchant_zarinpal';
const SECRET_VALUE = 'zp-LIVE-e2e-3f9a2b71';
const PLAIN_KEY = 'minbalancecart';

const PANEL_CODE = 'e2e-unreachable';

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
    await d
      .prepare(`DELETE FROM settings WHERE key IN (?1, ?2) AND updated_by = 'e2e'`)
      .bind(SECRET_KEY, PLAIN_KEY)
      .run();
    await d.prepare(`DELETE FROM provisioning_providers WHERE code = ?1`).bind(PANEL_CODE).run();
  });

test.beforeAll(async () => {
  await wipe();
  await withDb(async (d) => {
    for (const [scope, key, value] of [
      ['pay', SECRET_KEY, SECRET_VALUE],
      ['pay', PLAIN_KEY, '80000'],
    ] as const) {
      await d
        .prepare(
          `INSERT INTO settings (scope, key, value, updated_at, updated_by)
           VALUES (?1, ?2, ?3::jsonb, now(), 'e2e')
           ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'e2e'`,
        )
        .bind(scope, key, JSON.stringify(value))
        .run();
    }
    // A panel the shop believes is open for business and that cannot answer:
    // ACTIVE, a kind that reaches over the network, and neither an address nor
    // a credential. Both columns are nullable, so this is a state the schema
    // permits and production can reach by adding a panel and stopping halfway.
    await d
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref)
         VALUES (?1, 'پنل ناتمام (e2e)', 'pasarguard', 'ACTIVE', NULL, NULL)`,
      )
      .bind(PANEL_CODE)
      .run();
  });
});

test.afterAll(wipe);

test('a gateway credential is never sent to the browser, and cannot be written back', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  await expect(page.locator('.sidebar-link.active')).toHaveText('تنظیمات');

  const row = page.locator(`tbody tr:has-text("${SECRET_KEY}")`);
  await expect(row).toContainText('ثبت شده');
  // Locked rather than editable, so the control itself says why.
  await expect(row.getByRole('button', { name: 'ویرایش' })).toHaveCount(0);

  // Not merely absent from the table — absent from the document, and absent
  // from what the server actually put on the wire. A masked cell above a
  // response that carries the value is a leak with a polite front end.
  await expect(page.locator('body')).not.toContainText(SECRET_VALUE);
  const onTheWire = await page.evaluate(async () => {
    const r = await fetch('/api/v1/admin/settings', { credentials: 'include' });
    return r.text();
  });
  expect(onTheWire).not.toContain(SECRET_VALUE);

  // And the write is refused server-side, not merely un-offered on screen.
  const refused = await page.evaluate(
    async ([key, value]) => {
      const r = await fetch('/api/v1/admin/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'pay', key, value: `${value}-tampered` }),
      });
      return { status: r.status, body: await r.text() };
    },
    [SECRET_KEY, SECRET_VALUE],
  );
  expect(refused.status).toBe(403);

  const stored = await withDb((d) =>
    d
      .prepare(`SELECT value::text AS v FROM settings WHERE scope = 'pay' AND key = ?1`)
      .bind(SECRET_KEY)
      .first<{ v: string }>(),
  );
  expect(stored?.v).toContain(SECRET_VALUE);
  expect(stored?.v).not.toContain('tampered');
});

test('a key the bot does not read cannot be invented from this screen', async ({ page }) => {
  await page.goto('/admin/settings');

  // The bot reads a fixed list (`SHOP_SETTING_KEYS`). A key created here would
  // be a row nothing ever reads, which looks to an admin like a setting that
  // does not work — worse than not offering it.
  const invented = await page.evaluate(async () => {
    const r = await fetch('/api/v1/admin/settings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'bot', key: 'e2e_invented_key', value: '1' }),
    });
    return r.status;
  });
  expect(invented).toBe(404);

  const none = await withDb((d) =>
    d
      .prepare(`SELECT count(*)::int AS n FROM settings WHERE key = 'e2e_invented_key'`)
      .first<{ n: number }>(),
  );
  expect(none?.n).toBe(0);
});

test('a plain setting is still editable, so the lock is about credentials', async ({ page }) => {
  await page.goto('/admin/settings');
  const row = page.locator(`tbody tr:has-text("${PLAIN_KEY}")`);
  // The premise: if everything on this screen were locked the test above would
  // pass for a screen that simply refuses all writes.
  await expect(row.getByRole('button', { name: 'ویرایش' })).toBeVisible();
  await expect(row).toContainText('80000');
});

test('a panel that cannot deliver does not read as فعال', async ({ page }) => {
  await page.goto('/admin/panels');
  await expect(page.locator('.sidebar-link.active')).toHaveText('مدیریت پنل‌ها');

  const row = page.locator(`tbody tr:has-text("${PANEL_CODE}")`);
  // The status column reported the admin's intent and nothing else. This panel
  // is ACTIVE and PasarGuard with no address and no credential, so
  // `marzban.ts:147` answers every order with `retryable: false` — the customer
  // pays, waits, and is refunded with «تماس بگیرید». The row already carried
  // everything needed to say so before a single order was placed.
  await expect(row).toContainText('بدون آدرس و اعتبارنامه');
  await expect(row).toContainText('سفارشی از این پنل تحویل نمی‌شود');
  await expect(row.locator('.badge-active')).toHaveCount(0);
});

test('a panel that fulfils by hand is not flagged for having no address', async ({ page }) => {
  // The other half, and the reason the check lists kinds rather than testing
  // `!== 'manual'`: a `manual` panel has no address because it does not need
  // one, and flagging it would train an operator to ignore the flag.
  await withDb((d) =>
    d
      .prepare(`UPDATE provisioning_providers SET kind = 'manual' WHERE code = ?1`)
      .bind(PANEL_CODE)
      .run(),
  );
  await page.goto('/admin/panels');
  const row = page.locator(`tbody tr:has-text("${PANEL_CODE}")`);
  await expect(row).not.toContainText('سفارشی از این پنل تحویل نمی‌شود');
  await expect(row.locator('.badge-active')).toHaveCount(1);

  await withDb((d) =>
    d
      .prepare(`UPDATE provisioning_providers SET kind = 'pasarguard' WHERE code = ?1`)
      .bind(PANEL_CODE)
      .run(),
  );
});

test('a reseller application can be decided, once', async ({ page }) => {
  const applicant = await withDb(async (d) => {
    await d.prepare(`DELETE FROM reseller_requests WHERE description = 'e2e — درخواست'`).run();
    return d
      .prepare(
        `INSERT INTO reseller_requests (user_id, description, status, created_at)
         SELECT id, 'e2e — درخواست', 'PENDING', now() FROM users
          WHERE is_reseller = false ORDER BY id LIMIT 1
         RETURNING id, user_id`,
      )
      .first<{ id: number; user_id: number }>();
  });

  await page.goto('/admin/requests');
  await expect(page.locator('.sidebar-link.active')).toHaveText('لیست درخواست‌ها');
  const row = page.locator(`tbody tr:has-text("e2e — درخواست")`);

  // Approving asks first, and the question says what approval opens rather
  // than «مطمئنید؟» — the first version of this test dismissed the dialog it
  // did not know was there and then reported that the button did nothing.
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await row.getByRole('button', { name: 'تایید' }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('قیمت‌های نمایندگی برایش باز می‌شود');
  // The list opens on «در انتظار», so a decided application leaves it rather
  // than changing colour in place. Asserting the row's text would wait five
  // seconds for an element that is correctly gone.
  await expect(row).toHaveCount(0);
  await page.locator('#req-status').selectOption('');
  await expect(page.locator(`tbody tr:has-text("e2e — درخواست")`)).toContainText('تایید شده');

  // Approving is what actually makes somebody a reseller — it is the flag the
  // catalogue's `resellers_only` reads, so asserting the request row alone
  // would miss the half that changes what the customer can buy.
  const after = await withDb((d) =>
    d
      .prepare(
        `SELECT r.status, u.is_reseller FROM reseller_requests r
           JOIN users u ON u.id = r.user_id WHERE r.id = ?1`,
      )
      .bind(applicant!.id)
      .first<{ status: string; is_reseller: boolean }>(),
  );
  expect(after?.status).toBe('APPROVED');
  expect(after?.is_reseller).toBe(true);

  // Decided once: a second decision from a stale tab would flip the flag back.
  const second = await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/admin/reseller-requests/${id}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    });
    return r.status;
  }, applicant!.id);
  expect(second).toBe(409);

  await withDb(async (d) => {
    await d.prepare(`DELETE FROM reseller_requests WHERE description = 'e2e — درخواست'`).run();
    await d
      .prepare(`UPDATE users SET is_reseller = false WHERE id = ?1`)
      .bind(applicant!.user_id)
      .run();
  });
});

test('an operator cannot remove their own way in', async ({ page }) => {
  await page.goto('/admin/access');
  await expect(page.locator('.sidebar-link.active')).toHaveText('دسترسی‌ها');

  // The row for whoever is signed in carries no delete and no disable. Locking
  // yourself out of a panel that is the only way to unlock it is not an error
  // worth reporting afterwards — it has to be impossible to press.
  const me = page.locator('tbody tr:has-text("خودتان")');
  await expect(me).toHaveCount(1);
  await expect(me.getByRole('button')).toHaveCount(0);

  // Somebody else's row keeps both, so this is about identity and not about
  // the table being read-only.
  const others = page.locator('tbody tr:has-text("@shikoo.local")').first();
  await expect(others.getByRole('button', { name: 'حذف' })).toBeVisible();
});
