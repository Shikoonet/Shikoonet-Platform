/**
 * Credit every wallet and message every customer, from the web panel.
 *
 * The balance claims here are re-derived from `SUM(wallet_entries.amount_irr)`
 * rather than read back from the route, for the reason `customers.test.ts`
 * states: a test that compares a route's answer to the route's own read passes
 * even when the route assigns a balance directly, which is the one failure the
 * ledger design exists to prevent.
 *
 * The assertion that matters most is the second call. Bulk credit has no undo
 * and eleven thousand customers, so «pressing it twice does nothing the second
 * time» is not a nicety — it is the whole reason the batch id comes from the
 * client. That guarantee is a partial unique index on
 * `wallet_entries.idempotency_key`, not code, and this proves the route is
 * actually leaning on it.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';

const ADMIN = 'admin-bulk@example.com';
const REVIEWER = 'reviewer-bulk@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/** Telegram ids far above anything another suite seeds. */
const TG_BASE = 993_000_000;
let seq = 0;

async function makeCustomer(status = 'ACTIVE'): Promise<number> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, ?3, now()) RETURNING id`,
  )
    .bind(telegramId, `bulk-${seq}`, status)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function ledgerSum(userId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT COALESCE(SUM(amount_irr), 0)::bigint AS n FROM wallet_entries WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * How many customers the shop-wide routes are supposed to reach, right now.
 *
 * These tests used to assert the literal number they had just created — two
 * customers, so `credited` must be 2. That is only true while `users` holds
 * nothing else, and `beforeEach` here deletes only the rows this file made. It
 * passed for months and went red the first time `pnpm e2e` ran before the unit
 * suite, because `e2e/global-setup.ts` seeds a shop.
 *
 * The number was never the claim. The claim is "every ACTIVE customer, once",
 * so that is what is asserted, against the population the database actually
 * holds. Rule 8 in CLAUDE.md is the same shape from the other side: a test that
 * is green because of what else happened to run.
 */
async function activeCustomers(): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function recipientCount(broadcastId: string): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = ?1`,
  )
    .bind(broadcastId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'READ_ONLY'],
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
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id >= ?1`).bind(TG_BASE).run();
});

describe('bulk credit', () => {
  it('credits every active customer once, and a blocked one not at all', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const blocked = await makeCustomer('BLOCKED');
    const active = await activeCustomers();

    const res = await app.request(
      '/api/v1/admin/bulk/credit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 50_000, batchId: uuid() }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { credited: number }).credited).toBe(active);

    expect(await ledgerSum(a)).toBe(50_000);
    expect(await ledgerSum(b)).toBe(50_000);
    expect(await ledgerSum(blocked)).toBe(0);
    // Once each, which the sums above cannot show on their own: two entries of
    // 25,000 would add up the same way.
    const entries = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM wallet_entries WHERE user_id = ?1`,
    )
      .bind(a)
      .first<{ n: number }>();
    expect(entries?.n).toBe(1);
  });

  it('is a no-op the second time the same batch arrives', async () => {
    const a = await makeCustomer();
    const batchId = uuid();
    const send = () =>
      app.request(
        '/api/v1/admin/bulk/credit',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr: 50_000, batchId }),
        },
        envAs(ADMIN),
      );

    const active = await activeCustomers();
    expect(((await (await send()).json()) as { credited: number }).credited).toBe(active);
    // 0 is the honest answer: nothing moved this time.
    expect(((await (await send()).json()) as { credited: number }).credited).toBe(0);
    expect(await ledgerSum(a)).toBe(50_000);
  });

  it('treats a different batch as a different decision', async () => {
    const a = await makeCustomer();
    for (const batchId of [uuid(), uuid()]) {
      await app.request(
        '/api/v1/admin/bulk/credit',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr: 50_000, batchId }),
        },
        envAs(ADMIN),
      );
    }
    expect(await ledgerSum(a)).toBe(100_000);
  });

  it('refuses an amount over the single-adjustment ceiling', async () => {
    await makeCustomer();
    const res = await app.request(
      '/api/v1/admin/bulk/credit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: MAX_SINGLE_PAYMENT_IRR + 1, batchId: uuid() }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(400);
  });

  it('refuses a reviewer', async () => {
    await makeCustomer();
    const res = await app.request(
      '/api/v1/admin/bulk/credit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 50_000, batchId: uuid() }),
      },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
    expect(await ledgerSum(1)).toBe(0);
  });

  it('writes an audit row naming the operator, not the batch alone', async () => {
    await makeCustomer();
    const batchId = uuid();
    await app.request(
      '/api/v1/admin/bulk/credit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 50_000, batchId }),
      },
      envAs(ADMIN),
    );
    const row = await baseEnv.DB.prepare(
      `SELECT actor_email, action FROM audit_logs WHERE entity_id = ?1`,
    )
      .bind(batchId)
      .first<{ actor_email: string; action: string }>();
    expect(row?.actor_email).toBe(ADMIN);
    expect(row?.action).toBe('customers.bulk_credited');
  });
});

describe('broadcast', () => {
  it('queues one recipient per active customer and sends nothing', async () => {
    await makeCustomer();
    await makeCustomer();
    await makeCustomer('BLOCKED');
    const active = await activeCustomers();
    const broadcastId = uuid();

    const res = await app.request(
      '/api/v1/admin/bulk/broadcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'سلام', broadcastId }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queued: number }).queued).toBe(active);
    expect(await recipientCount(broadcastId)).toBe(active);

    // Still PENDING: this route writes the list down, the bot's poll loop is
    // what sends. A route that sent inline would leave nothing to resume from.
    const pending = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM broadcast_recipients
        WHERE broadcast_id = ?1 AND status = 'PENDING'`,
    )
      .bind(broadcastId)
      .first<{ n: number }>();
    expect(pending?.n).toBe(active);
  });

  it('does not double-queue the same broadcast', async () => {
    await makeCustomer();
    const broadcastId = uuid();
    const send = () =>
      app.request(
        '/api/v1/admin/bulk/broadcast',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'سلام', broadcastId }),
        },
        envAs(ADMIN),
      );
    const active = await activeCustomers();
    await send();
    await send();
    expect(await recipientCount(broadcastId)).toBe(active);
  });

  it('refuses an empty body and a reviewer', async () => {
    await makeCustomer();
    const empty = await app.request(
      '/api/v1/admin/bulk/broadcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '   ', broadcastId: uuid() }),
      },
      envAs(ADMIN),
    );
    expect(empty.status).toBe(400);

    const reviewer = await app.request(
      '/api/v1/admin/bulk/broadcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'سلام', broadcastId: uuid() }),
      },
      envAs(REVIEWER),
    );
    expect(reviewer.status).toBe(403);
  });
});

describe('one customer', () => {
  it('sets the permanent discount and records what it was', async () => {
    const id = await makeCustomer();
    const res = await app.request(
      `/api/v1/admin/customers/${id}/discount`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ percent: 15 }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(`SELECT discount_percent FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ discount_percent: number }>();
    expect(row?.discount_percent).toBe(15);

    const log = await baseEnv.DB.prepare(
      `SELECT before_json, after_json FROM audit_logs
        WHERE entity_id = ?1 AND action = 'customer.discount_set'`,
    )
      .bind(String(id))
      .first<{ before_json: string; after_json: string }>();
    // The old value too: «set to 15» is not reviewable without «from what».
    expect(log?.before_json).toContain('0');
    expect(log?.after_json).toContain('15');
  });

  it('refuses a percentage above 100 and a reviewer', async () => {
    const id = await makeCustomer();
    for (const [email, percent, status] of [
      [ADMIN, 101, 400],
      [REVIEWER, 10, 403],
    ] as const) {
      const res = await app.request(
        `/api/v1/admin/customers/${id}/discount`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ percent }),
        },
        envAs(email),
      );
      expect(res.status).toBe(status);
    }
    const row = await baseEnv.DB.prepare(`SELECT discount_percent FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ discount_percent: number }>();
    expect(row?.discount_percent).toBe(0);
  });

  it('queues one message with the shop prefix in front of it', async () => {
    const id = await makeCustomer();
    const messageId = uuid();
    const res = await app.request(
      `/api/v1/admin/customers/${id}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'سرویس شما تمدید شد', messageId }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    expect(await recipientCount(messageId)).toBe(1);

    // Not the bare body: an unattributed message from a bot somebody bought a
    // subscription from reads as a scam. The prefix is the editable text the
    // bot renders, so this asserts the body is *inside* something longer.
    const row = await baseEnv.DB.prepare(`SELECT body FROM broadcasts WHERE id = ?1`)
      .bind(messageId)
      .first<{ body: string }>();
    expect(row?.body).toContain('سرویس شما تمدید شد');
    expect(row?.body.length).toBeGreaterThan('سرویس شما تمدید شد'.length);
  });

  it('will not message a blocked customer', async () => {
    const id = await makeCustomer('BLOCKED');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'سلام', messageId: uuid() }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(409);
  });

  it('does not deliver the same message twice', async () => {
    const id = await makeCustomer();
    const messageId = uuid();
    const send = () =>
      app.request(
        `/api/v1/admin/customers/${id}/message`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'سلام', messageId }),
        },
        envAs(ADMIN),
      );
    expect((await send()).status).toBe(200);
    // The second attempt inserts no recipient, so the route reports it as
    // nothing queued rather than silently promising a second delivery.
    expect((await send()).status).toBe(409);
    expect(await recipientCount(messageId)).toBe(1);
  });
});

describe('reach', () => {
  it('counts active customers only', async () => {
    await makeCustomer();
    await makeCustomer('BLOCKED');
    const res = await app.request('/api/v1/admin/bulk/reach', {}, envAs(ADMIN));
    const body = (await res.json()) as { reach: number };
    // Other suites' customers may still be in the table, so the assertion is
    // relative: whatever the count is, the blocked row is not in it.
    const active = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`,
    ).first<{ n: number }>();
    expect(body.reach).toBe(active?.n);
  });
});

/**
 * Repricing a whole panel from the web panel.
 *
 * The arithmetic itself is proved against a real Postgres in
 * `packages/domain/test/integration/bulkPrice.pg.test.ts` — rounding, the
 * floor, the scope. What is left for this file is the part only a route has:
 * who may press it, that a refusal is a refusal rather than a half-applied
 * price list, and that the audit row records what the prices WERE, since after
 * the write nothing else can say.
 */
describe('bulk repricing', () => {
  let panel = 0;

  async function seedPanel(prices: number[]): Promise<void> {
    await baseEnv.DB.prepare(`DELETE FROM product_plans WHERE name LIKE 'wbp-%'`).run();
    await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE 'wbp-%'`).run();
    await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code = 'wbp-panel'`).run();
    const pr = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status)
       VALUES ('wbp-panel', 'wbp-panel', 'manual', 'ACTIVE') RETURNING id`,
    ).first<{ id: number }>();
    panel = pr!.id;
    const prod = await baseEnv.DB.prepare(
      `INSERT INTO products (code, name, kind, provider_id, category_id, status)
       VALUES ('wbp-p', 'wbp-p', 'vpn', ?1, (SELECT id FROM product_categories WHERE name = '__fixture'), 'ACTIVE') RETURNING id`,
    )
      .bind(panel)
      .first<{ id: number }>();
    for (const [i, price] of prices.entries()) {
      await baseEnv.DB.prepare(
        `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
         VALUES (?1, ?2, ?3, 30, 'ACTIVE')`,
      )
        .bind(prod!.id, `wbp-${i}`, price)
        .run();
    }
  }

  async function pricesNow(): Promise<number[]> {
    const { results } = await baseEnv.DB.prepare(
      `SELECT price_irr FROM product_plans WHERE name LIKE 'wbp-%' ORDER BY name`,
    ).all<{ price_irr: number }>();
    return (results ?? []).map((r) => Number(r.price_irr));
  }

  const post = (path: string, body: unknown, who: string) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      envAs(who),
    );

  beforeEach(async () => {
    await seedPanel([100_000, 500_000]);
  });

  it('previews without writing, for a read-only operator too', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price/preview',
      { providerId: panel, mode: 'FIXED', direction: 'UP', amount: 50_000, operationId: uuid() },
      REVIEWER,
    );
    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as { preview: { plans: number; newTotalIrr: number } };
    expect(preview.plans).toBe(2);
    expect(preview.newTotalIrr).toBe(700_000);
    // Looking is not touching.
    expect(await pricesNow()).toEqual([100_000, 500_000]);
  });

  it('refuses to apply for anyone who is not an admin', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price',
      { providerId: panel, mode: 'FIXED', direction: 'UP', amount: 50_000, operationId: uuid() },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    expect(await pricesNow()).toEqual([100_000, 500_000]);
  });

  it('applies, and writes down what the prices were', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price',
      { providerId: panel, mode: 'PERCENT', direction: 'UP', amount: 10, operationId: uuid() },
      ADMIN,
    );
    expect(res.status).toBe(200);
    expect(await pricesNow()).toEqual([110_000, 550_000]);

    // The audit row is the only record of the old price list, and it has to
    // carry enough to put it back. A total and a count cannot be undone, which
    // is what it stored until 2026-08-21; every plan with both of its prices
    // can. Read from `audit_logs` rather than from the response, which is the
    // thing under test.
    const row = await baseEnv.DB.prepare(
      `SELECT before_json::text AS b, after_json::text AS a FROM audit_logs
        WHERE action = 'catalog.bulk_repriced' ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).first<{ b: string | null; a: string | null }>();
    expect(row?.b).toContain('100000');
    expect(row?.b).toContain('500000');
    expect(row?.a).toContain('110000');
    expect(row?.a).toContain('550000');
  });

  it('applies a repeated press once, not twice', async () => {
    // A price change compounds: two deliveries of "up 10%" are 21%, not 10%
    // twice — and a lost response between the server and the browser is enough
    // to produce them. There is no undo either, because the rounding is lossy.
    // This was the only irreversible action on the screen and the only one
    // without a key.
    const operationId = uuid();
    const body = { providerId: panel, mode: 'PERCENT', direction: 'UP', amount: 10, operationId };

    const first = await post('/api/v1/admin/bulk/price', body, ADMIN);
    const second = await post('/api/v1/admin/bulk/price', body, ADMIN);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()) as unknown).toMatchObject({ changed: 2, replayed: false });
    // The honest answer to the second press: your change is applied, and this
    // press did nothing.
    expect((await second.json()) as unknown).toMatchObject({ changed: 2, replayed: true });
    // 121,000 and 605,000 are what the second press used to produce.
    expect(await pricesNow()).toEqual([110_000, 550_000]);

    // And exactly one record of it.
    const n = await baseEnv.DB.prepare(`SELECT count(*)::int AS n FROM audit_logs WHERE id = ?1`)
      .bind(operationId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('lets a genuinely new change through on the same panel', async () => {
    // The key is per press, not per panel. An operator who really does want a
    // second rise must get one.
    const mk = () => ({
      providerId: panel,
      mode: 'FIXED' as const,
      direction: 'UP' as const,
      amount: 10_000,
      operationId: uuid(),
    });
    await post('/api/v1/admin/bulk/price', mk(), ADMIN);
    await post('/api/v1/admin/bulk/price', mk(), ADMIN);

    expect(await pricesNow()).toEqual([120_000, 520_000]);
  });

  it('refuses a body with no key at all', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price',
      { providerId: panel, mode: 'PERCENT', direction: 'UP', amount: 10 },
      ADMIN,
    );
    expect(res.status).toBe(400);
    expect(await pricesNow()).toEqual([100_000, 500_000]);
  });

  it('turns an impossible change into a 409 and no write at all', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price',
      { providerId: panel, mode: 'FIXED', direction: 'DOWN', amount: 200_000, operationId: uuid() },
      ADMIN,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('unsellable');
    // Not even the plan that could have absorbed it.
    expect(await pricesNow()).toEqual([100_000, 500_000]);
  });

  it('refuses a percentage that would make everything free', async () => {
    const res = await post(
      '/api/v1/admin/bulk/price',
      { providerId: panel, mode: 'PERCENT', direction: 'DOWN', amount: 100, operationId: uuid() },
      ADMIN,
    );
    expect(res.status).toBe(400);
    expect(await pricesNow()).toEqual([100_000, 500_000]);
  });
});
