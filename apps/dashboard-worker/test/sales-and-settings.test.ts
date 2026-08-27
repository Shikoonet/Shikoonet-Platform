/**
 * The three read-only ledgers, the settings, and the reseller queue.
 *
 * Two assertions here are the reason the file exists.
 *
 * The settings route is checked against the real key names from the production
 * dump — `apinowpayment`, `merchant_zarinpal`, `walletaddress` and the rest —
 * with a canary value planted in each, and the whole serialized response is
 * searched for that canary. Listing the keys I remembered to mask would pass
 * while the one I forgot leaked.
 *
 * The wallet totals are checked against `SUM` computed separately, because a
 * total taken over the page rather than over the filter reads as the shop's
 * figure and is wrong by the number of pages.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { isSecretKey } from '../src/settingsRoutes.js';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-sales@example.com';
const TG_BASE = 950_000_000;
const CANARY = 'zz-canary-live-credential';
let seq = 0;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/**
 * Every key in `PaySetting` that carries a credential, as spelled in the
 * production dump on 2026-08-14. `marchent_` is the dump's spelling, not a typo
 * in this test.
 */
const REAL_SECRET_KEYS = [
  'apiiranpay',
  'apinowpayment',
  'apiternado',
  'merchant_id_aqayepardakht',
  'merchant_zarinpal',
  'marchent_floypay',
  'marchent_tronseller',
  'walletaddress',
];

/** And keys that are not credentials and must stay readable. */
const REAL_PLAIN_KEYS = ['maxbalancecart', 'minbalance', 'cardnumber', 'namecard'];

async function makeUser(): Promise<{ id: number; telegramId: number }> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
  )
    .bind(telegramId, `zzsales_${seq}`)
    .first<{ id: number }>();
  return { id: Number(row!.id), telegramId };
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM reseller_requests WHERE user_id IN (SELECT id FROM users WHERE telegram_id >= ?1)`,
  )
    .bind(TG_BASE)
    .run();
  await baseEnv.DB.prepare(
    `DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE telegram_id >= ?1)`,
  )
    .bind(TG_BASE)
    .run();
  await baseEnv.DB.prepare(
    `DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE telegram_id >= ?1)`,
  )
    .bind(TG_BASE)
    .run();
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id >= ?1`).bind(TG_BASE).run();
  await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'pay'`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  await purge();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purge);

describe('settings', () => {
  async function seedPaySettings(): Promise<void> {
    for (const key of [...REAL_SECRET_KEYS, ...REAL_PLAIN_KEYS]) {
      await baseEnv.DB.prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('pay', ?1, ?2::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
        .bind(key, JSON.stringify(REAL_SECRET_KEYS.includes(key) ? CANARY : '12345'))
        .run();
    }
  }

  it('never puts a gateway credential on the wire, by any of its real key names', async () => {
    await seedPaySettings();

    const res = await app.request('/api/v1/admin/settings?scope=pay', {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const raw = await res.text();

    // The canary is genuinely stored under every one of those keys.
    const stored = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM settings WHERE scope = 'pay' AND value::text LIKE ?1`,
    )
      .bind(`%${CANARY}%`)
      .first<{ n: number }>();
    expect(stored!.n).toBe(REAL_SECRET_KEYS.length);

    // And nowhere in the response.
    expect(raw).not.toContain(CANARY);

    const body = JSON.parse(raw) as {
      hiddenCount: number;
      items: Array<{ key: string; secret: boolean; value: unknown; isSet: boolean }>;
    };
    expect(body.hiddenCount).toBe(REAL_SECRET_KEYS.length);

    for (const key of REAL_SECRET_KEYS) {
      const row = body.items.find((i) => i.key === key)!;
      expect(row.secret).toBe(true);
      expect(row.value).toBeNull();
      // Still says whether it is configured — that is the operational fact.
      expect(row.isSet).toBe(true);
    }
    // A limit is not a credential and stays readable, otherwise the screen is
    // useless.
    for (const key of REAL_PLAIN_KEYS) {
      const row = body.items.find((i) => i.key === key)!;
      expect(row.secret).toBe(false);
      expect(row.value).toBe('12345');
    }
  });

  it('classifies the dump’s own key names, including the misspelled ones', async () => {
    for (const key of REAL_SECRET_KEYS) expect(isSecretKey(key)).toBe(true);
    for (const key of REAL_PLAIN_KEYS) expect(isSecretKey(key)).toBe(false);
    // Case does not matter: the legacy columns are mixed case.
    expect(isSecretKey('APIKey')).toBe(true);
  });

  /**
   * The row `0035` inserts, put back.
   *
   * It is real data rather than schema, and `apps/bot/test/shop-settings.test.ts`
   * clears every key in `SHOP_SETTING_KEYS` to prove the defaults — this one
   * included, now that it is one of them. Seeding here rather than depending on
   * the migration is the same choice `seedPaySettings` makes above.
   */
  async function seedTemplateRow(): Promise<void> {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('shop', 'plan_button_template', '""'::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    ).run();
  }

  it('refuses a plan-button template that names a field the bot does not have', async () => {
    await seedTemplateRow();
    // Saved, this draws the literal characters «{prise}» on a button — or, on
    // the bot's own guard, is ignored entirely and the operator sees the screen
    // not change with nothing telling them why. The refusal is the only place
    // that answer can come from, so it has to happen here.
    const res = await app.request(
      '/api/v1/admin/settings',
      {
        method: 'POST',
        body: JSON.stringify({
          scope: 'shop',
          key: 'plan_button_template',
          value: '{duration} | {prise}',
        }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; tokens: Array<{ name: string }> };
    expect(body.error).toBe('invalid_template');
    // The refusal carries the field list, because the settings screen is a
    // generic key/value editor with nowhere to document a grammar.
    expect(body.tokens.map((t) => t.name)).toContain('price');

    const row = await baseEnv.DB.prepare(
      `SELECT value::text AS v FROM settings WHERE scope = 'shop' AND key = 'plan_button_template'`,
    ).first<{ v: string }>();
    expect(row!.v).not.toContain('prise');
  });

  it('accepts a valid plan-button template, and accepts emptying it again', async () => {
    await seedTemplateRow();
    const save = (value: string) =>
      app.request(
        '/api/v1/admin/settings',
        {
          method: 'POST',
          body: JSON.stringify({ scope: 'shop', key: 'plan_button_template', value }),
        },
        envAs(ADMIN),
      );

    expect((await save('{duration} | {volume} | {price}')).status).toBe(200);
    const set = await baseEnv.DB.prepare(
      `SELECT value::text AS v FROM settings WHERE scope = 'shop' AND key = 'plan_button_template'`,
    ).first<{ v: string }>();
    expect(set!.v).toContain('{duration}');

    // Empty is how a shop goes back to the label the bot has always drawn, so
    // it is a legitimate save rather than a failed validation.
    expect((await save('')).status).toBe(200);
  });

  it('refuses to write a secret key even for an admin', async () => {
    await seedPaySettings();
    const res = await app.request(
      '/api/v1/admin/settings',
      {
        method: 'POST',
        body: JSON.stringify({ scope: 'pay', key: 'merchant_zarinpal', value: 'new' }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(403);

    const row = await baseEnv.DB.prepare(
      `SELECT value::text AS v FROM settings WHERE scope = 'pay' AND key = 'merchant_zarinpal'`,
    ).first<{ v: string }>();
    expect(row!.v).toContain(CANARY);
  });

  it('updates an existing setting and records the change', async () => {
    await seedPaySettings();
    const res = await app.request(
      '/api/v1/admin/settings',
      {
        method: 'POST',
        body: JSON.stringify({ scope: 'pay', key: 'maxbalancecart', value: '20000000' }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT value::text AS v, updated_by FROM settings WHERE scope='pay' AND key='maxbalancecart'`,
    ).first<{ v: string; updated_by: string }>();
    expect(row!.v).toBe('"20000000"');
    expect(row!.updated_by).toBe(ADMIN);

    const logs = await baseEnv.DB.prepare(
      `SELECT entity_id, before_json, after_json FROM audit_logs WHERE entity_type = 'SETTING'`,
    ).all<{ entity_id: string; before_json: string; after_json: string }>();
    expect(logs.results).toHaveLength(1);
    expect(logs.results![0]!.entity_id).toBe('pay:maxbalancecart');
  });

  it('refuses to invent a key the bot will never read', async () => {
    const res = await app.request(
      '/api/v1/admin/settings',
      { method: 'POST', body: JSON.stringify({ scope: 'bot', key: 'zz_made_up', value: 'x' }) },
      envAs(ADMIN),
    );
    expect(res.status).toBe(404);
    const row = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM settings WHERE key = 'zz_made_up'`,
    ).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('is refused for a reviewer', async () => {
    await seedPaySettings();
    const res = await app.request(
      '/api/v1/admin/settings',
      { method: 'POST', body: JSON.stringify({ scope: 'pay', key: 'minbalance', value: '1' }) },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
  });
});

describe('the read-only ledgers', () => {
  it('lists orders with the customer, and filters by status and kind', async () => {
    const { id: userId } = await makeUser();
    for (const [kind, status, total] of [
      ['NEW_PURCHASE', 'COMPLETED', 1_000_000],
      ['RENEWAL', 'FAILED', 500_000],
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, quantity, discount_irr, total_irr, status)
         VALUES (?1, ?2, ?3, ?4, 1, 0, ?4, ?5)`,
      )
        .bind(crypto.randomUUID(), userId, kind, total, status)
        .run();
    }

    const all = await app.request(`/api/v1/admin/orders?q=${TG_BASE + seq}`, {}, envAs(ADMIN));
    const body = (await all.json()) as {
      total: number;
      items: Array<{ customer: { id: number }; totalIrr: number }>;
    };
    expect(body.total).toBe(2);
    expect(body.items[0]!.customer.id).toBe(userId);

    const failed = await app.request(
      `/api/v1/admin/orders?q=${TG_BASE + seq}&status=FAILED`,
      {},
      envAs(ADMIN),
    );
    expect(((await failed.json()) as { total: number }).total).toBe(1);

    const renewals = await app.request(
      `/api/v1/admin/orders?q=${TG_BASE + seq}&kind=RENEWAL`,
      {},
      envAs(ADMIN),
    );
    expect(((await renewals.json()) as { total: number }).total).toBe(1);
  });

  it('shows an order whose plan has been retired rather than hiding it', async () => {
    // `orders.plan_id` is ON DELETE SET NULL, so this is the state a retired
    // plan leaves behind. The sale still happened.
    const { id: userId, telegramId } = await makeUser();
    await baseEnv.DB.prepare(
      `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, quantity, discount_irr, total_irr, status, plan_id)
       VALUES (?1, ?2, 'NEW_PURCHASE', 100, 1, 0, 100, 'COMPLETED', NULL)`,
    )
      .bind(crypto.randomUUID(), userId)
      .run();

    const res = await app.request(`/api/v1/admin/orders?q=${telegramId}`, {}, envAs(ADMIN));
    const body = (await res.json()) as { items: Array<{ planName: string | null }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.planName).toBeNull();
  });

  it('lists subscriptions under the names they carried at sale', async () => {
    const { id: userId, telegramId } = await makeUser();
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, provider_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, 'پلن قدیمی', 'پنل قدیمی', 1000, 'ACTIVE', now())`,
    )
      .bind(crypto.randomUUID(), userId)
      .run();

    const res = await app.request(`/api/v1/admin/subscriptions?q=${telegramId}`, {}, envAs(ADMIN));
    const body = (await res.json()) as {
      total: number;
      items: Array<{ planName: string; providerName: string | null }>;
    };
    expect(body.total).toBe(1);
    // Renaming the plan today must not rewrite what this customer bought.
    expect(body.items[0]!.planName).toBe('پلن قدیمی');
    expect(body.items[0]!.providerName).toBe('پنل قدیمی');
  });

  it('carries what the panel says was used, and when it said it', async () => {
    // The screen showed the volume SOLD and nothing else, while the bot's sweep
    // had been writing `used_bytes` off the panel every ten minutes since it was
    // written. This route already shipped `lastSyncedAt` — the timestamp of a
    // number it did not ship — so the panel could say how fresh a figure was and
    // never show the figure. An operator answering "my traffic ran out" had to
    // open PasarGuard.
    const { id: userId, telegramId } = await makeUser();
    const used = 3 * 1024 ** 3;
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at,
          volume_gb, used_bytes, last_synced_at)
       VALUES (?1, ?2, 'پلن', 1000, 'ACTIVE', now(), 10, ?3, now())`,
    )
      .bind(crypto.randomUUID(), userId, used)
      .run();

    const res = await app.request(`/api/v1/admin/subscriptions?q=${telegramId}`, {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: Array<{
        usedBytes: number | null;
        lastSyncedAt: string | null;
        volumeGb: number | null;
      }>;
    };
    const row = body.items[0]!;
    // A number, not a string: `used_bytes` is int8 and comes back as text from
    // some drivers, which would render as "3221225472 bytes" of nonsense.
    expect(row.usedBytes).toBe(used);
    expect(typeof row.usedBytes).toBe('number');
    expect(row.volumeGb).toBe(10);
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it('says nothing rather than zero when no panel has answered yet', async () => {
    // The distinction the screen has to draw. A service the sweep has never
    // reached has `used_bytes` NULL and `last_synced_at` NULL, and rendering
    // that as "0 گیگ" tells an operator the customer has used nothing — which
    // is exactly what an unreachable panel looks like too.
    const { id: userId, telegramId } = await makeUser();
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at, volume_gb)
       VALUES (?1, ?2, 'پلن', 1000, 'ACTIVE', now(), 10)`,
    )
      .bind(crypto.randomUUID(), userId)
      .run();

    const res = await app.request(`/api/v1/admin/subscriptions?q=${telegramId}`, {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: Array<{ usedBytes: number | null; lastSyncedAt: string | null }>;
    };
    expect(body.items[0]!.usedBytes).toBeNull();
    expect(body.items[0]!.lastSyncedAt).toBeNull();
  });

  it('totals the wallet over everything the filter matches, not over the page', async () => {
    const { id: userId, telegramId } = await makeUser();
    const amounts = [500_000, 300_000, -200_000, -50_000];
    for (const [i, amount] of amounts.entries()) {
      await baseEnv.DB.prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
         VALUES (?1, ?2, 'ADMIN_ADJUST', ?3)`,
      )
        .bind(userId, amount, `zz-sales-${seq}-${i}`)
        .run();
    }

    // One row per page, so a page-scoped total would be one row's worth.
    const res = await app.request(
      `/api/v1/admin/wallet-entries?q=${telegramId}&pageSize=1`,
      {},
      envAs(ADMIN),
    );
    const body = (await res.json()) as {
      total: number;
      creditIrr: number;
      debitIrr: number;
      items: unknown[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(4);

    // Against SUM computed separately, not against the arithmetic above.
    const sums = await baseEnv.DB.prepare(
      `SELECT COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr > 0), 0)::bigint AS credit,
              COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr < 0), 0)::bigint AS debit
         FROM wallet_entries WHERE user_id = ?1`,
    )
      .bind(userId)
      .first<{ credit: number; debit: number }>();
    expect(body.creditIrr).toBe(Number(sums!.credit));
    expect(body.debitIrr).toBe(Number(sums!.debit));
  });

  it('offers no way to write any of the three', async () => {
    // The wallet is append-only in Postgres and orders are written by the
    // purchase flow; a second writer here would race both.
    for (const path of [
      '/api/v1/admin/orders',
      '/api/v1/admin/subscriptions',
      '/api/v1/admin/wallet-entries',
    ]) {
      const res = await app.request(path, { method: 'POST', body: '{}' }, envAs(ADMIN));
      expect(res.status).toBe(404);
    }
  });

  it('is readable by a reviewer', async () => {
    expect((await app.request('/api/v1/admin/orders', {}, envAs(REVIEWER))).status).toBe(200);
    expect((await app.request('/api/v1/admin/subscriptions', {}, envAs(REVIEWER))).status).toBe(
      200,
    );
    expect((await app.request('/api/v1/admin/wallet-entries', {}, envAs(REVIEWER))).status).toBe(
      200,
    );
  });
});

describe('reseller requests', () => {
  async function makeRequest(): Promise<{ id: number; userId: number }> {
    const { id: userId } = await makeUser();
    const row = await baseEnv.DB.prepare(
      `INSERT INTO reseller_requests (user_id, description, status, created_at)
       VALUES (?1, 'می‌خواهم نماینده شوم', 'PENDING', now()) RETURNING id`,
    )
      .bind(userId)
      .first<{ id: number }>();
    return { id: Number(row!.id), userId };
  }

  it('approving one is what makes the customer a reseller', async () => {
    const { id, userId } = await makeRequest();

    const res = await app.request(
      `/api/v1/admin/reseller-requests/${id}`,
      { method: 'POST', body: JSON.stringify({ status: 'APPROVED' }) },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const user = await baseEnv.DB.prepare(`SELECT is_reseller FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ is_reseller: boolean }>();
    // The flag `products.resellers_only` reads.
    expect(user!.is_reseller).toBe(true);

    const req = await baseEnv.DB.prepare(
      `SELECT status, decided_at FROM reseller_requests WHERE id = ?1`,
    )
      .bind(id)
      .first<{ status: string; decided_at: string | null }>();
    expect(req!.status).toBe('APPROVED');
    expect(req!.decided_at).not.toBeNull();
  });

  it('rejecting one leaves the customer exactly as they were', async () => {
    const { id, userId } = await makeRequest();
    await app.request(
      `/api/v1/admin/reseller-requests/${id}`,
      { method: 'POST', body: JSON.stringify({ status: 'REJECTED' }) },
      envAs(ADMIN),
    );
    const user = await baseEnv.DB.prepare(`SELECT is_reseller FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ is_reseller: boolean }>();
    expect(user!.is_reseller).toBe(false);
  });

  it('cannot be decided twice', async () => {
    const { id, userId } = await makeRequest();
    await app.request(
      `/api/v1/admin/reseller-requests/${id}`,
      { method: 'POST', body: JSON.stringify({ status: 'REJECTED' }) },
      envAs(ADMIN),
    );
    // A stale screen must not be able to flip a reseller flag afterwards.
    const again = await app.request(
      `/api/v1/admin/reseller-requests/${id}`,
      { method: 'POST', body: JSON.stringify({ status: 'APPROVED' }) },
      envAs(ADMIN),
    );
    expect(again.status).toBe(409);
    const user = await baseEnv.DB.prepare(`SELECT is_reseller FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ is_reseller: boolean }>();
    expect(user!.is_reseller).toBe(false);
  });

  it('is refused for a reviewer', async () => {
    const { id, userId } = await makeRequest();
    const res = await app.request(
      `/api/v1/admin/reseller-requests/${id}`,
      { method: 'POST', body: JSON.stringify({ status: 'APPROVED' }) },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
    const user = await baseEnv.DB.prepare(`SELECT is_reseller FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ is_reseller: boolean }>();
    expect(user!.is_reseller).toBe(false);
  });

  it('puts the undecided ones first', async () => {
    const a = await makeRequest();
    await makeRequest();
    await app.request(
      `/api/v1/admin/reseller-requests/${a.id}`,
      { method: 'POST', body: JSON.stringify({ status: 'APPROVED' }) },
      envAs(ADMIN),
    );

    const res = await app.request('/api/v1/admin/reseller-requests', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: Array<{ status: string }> };
    expect(body.items[0]!.status).toBe('PENDING');
  });
});
