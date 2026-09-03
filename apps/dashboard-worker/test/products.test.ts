/**
 * The catalogue routes.
 *
 * Nothing here believes the response about what was saved. Every write is
 * re-read from `product_plans` / `products` in a separate query, because a
 * route that echoed its own request body back would pass a test that only
 * compared the response to what was sent — the failure rule 6 describes. The
 * audit rows are read the same way.
 *
 * The rows are inserted with codes carrying a prefix nothing else uses, and
 * removed by that prefix, so this suite never truncates a catalogue another
 * test in this package might be reading.
 */

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, fixtureCategory } from './helpers/env.js';
import { app } from '../src/index.js';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-products@example.com';
const PREFIX = 'zz-cat-test-';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

interface Made {
  providerId: number;
  productId: number;
  planId: number;
}

async function makeCatalog(
  label: string,
  opts: {
    priceIrr?: number;
    volumeGb?: number | null;
    durationDays?: number | null;
    resellersOnly?: boolean;
    planStatus?: string;
    productStatus?: string;
  } = {},
): Promise<Made> {
  const provider = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status)
     VALUES (?1, ?2, 'marzban', 'ACTIVE') RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, `پنل ${label}`)
    .first<{ id: number }>();
  const providerId = Number(provider!.id);

  const product = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, provider_id, category_id, status, resellers_only)
     VALUES (?1, ?2, 'vpn', ?3, (SELECT id FROM product_categories WHERE name = '__fixture'), ?4, ?5) RETURNING id`,
  )
    .bind(
      `${PREFIX}${label}`,
      `محصول ${label}`,
      providerId,
      opts.productStatus ?? 'ACTIVE',
      opts.resellersOnly ?? false,
    )
    .first<{ id: number }>();
  const productId = Number(product!.id);

  const plan = await baseEnv.DB.prepare(
    `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      productId,
      `پلن ${label}`,
      opts.priceIrr ?? 1_000_000,
      opts.durationDays === undefined ? 30 : opts.durationDays,
      opts.volumeGb === undefined ? 50 : opts.volumeGb,
      opts.planStatus ?? 'ACTIVE',
    )
    .first<{ id: number }>();

  return { providerId, productId, planId: Number(plan!.id) };
}

/**
 * A customer of this suite's own, keyed by a telegram id in a range nothing
 * else uses so the purge can find them again.
 */
async function makeUser(telegramId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at)
     VALUES (?1, ?2, now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username
     RETURNING id`,
  )
    .bind(telegramId, `${PREFIX}${telegramId}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

/** An order pointing at a plan — the reference the delete guard exists for. */
async function placeOrder(planId: number, telegramId: number): Promise<number> {
  const userId = await makeUser(telegramId);
  const row = await baseEnv.DB.prepare(
    `INSERT INTO orders (public_id, user_id, kind, plan_id, unit_price_irr, total_irr, status)
     VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1000000, 1000000, 'COMPLETED') RETURNING id`,
  )
    .bind(`${PREFIX}o${telegramId}`, userId, planId)
    .first<{ id: number }>();
  return Number(row!.id);
}

/** A subscription pointing at a plan. */
async function giveSubscription(
  planId: number,
  providerId: number,
  telegramId: number,
): Promise<void> {
  const userId = await makeUser(telegramId);
  await baseEnv.DB.prepare(
    `INSERT INTO subscriptions
       (public_id, user_id, plan_id, provider_id, plan_name_at_sale, price_irr, status, purchased_at)
     VALUES (?1, ?2, ?3, ?4, 'پلن فروخته‌شده', 1000000, 'ACTIVE', now())`,
  )
    .bind(`${PREFIX}s${telegramId}`, userId, planId, providerId)
    .run();
}

/** What the database says, not what the route said. */
async function planRow(id: number) {
  return baseEnv.DB.prepare(
    `SELECT name, price_irr::bigint AS price_irr, duration_days, volume_gb, status
       FROM product_plans WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      name: string;
      price_irr: number;
      duration_days: number | null;
      volume_gb: number | null;
      status: string;
    }>();
}

async function auditRows(entityType: string, entityId: number) {
  const rows = await baseEnv.DB.prepare(
    `SELECT action, actor_email, before_json, after_json
       FROM audit_logs WHERE entity_type = ?1 AND entity_id = ?2
      ORDER BY created_at DESC`,
  )
    .bind(entityType, String(entityId))
    .all<{ action: string; actor_email: string; before_json: string; after_json: string }>();
  return rows.results ?? [];
}

async function purge(): Promise<void> {
  // Outside in: stock and sales first, because the delete guard the suite is
  // testing is exactly what would otherwise stop `products` from going. Plans
  // cascade from products; products, providers and users go by their prefix.
  for (const sql of [
    `DELETE FROM provisioning_stock WHERE remote_username LIKE ?1`,
    `DELETE FROM subscriptions WHERE public_id LIKE ?1`,
    `DELETE FROM discount_codes WHERE code LIKE ?1`,
    `DELETE FROM orders WHERE public_id LIKE ?1`,
    `DELETE FROM products WHERE code LIKE ?1`,
    `DELETE FROM provisioning_providers WHERE code LIKE ?1`,
    `DELETE FROM product_categories WHERE name LIKE ?1`,
    `DELETE FROM users WHERE username LIKE ?1`,
  ]) {
    await baseEnv.DB.prepare(sql).bind(`${PREFIX}%`).run();
  }
}

let CATEGORY = 0;

beforeAll(async () => {
  await applySchema();
  // `categoryId` is required by `ProductCreate`, because `products.category_id`
  // is NOT NULL — a service without one has no button on any shop screen.
  CATEGORY = await fixtureCategory();
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

describe('GET /api/v1/admin/products', () => {
  it('returns one row per plan, carrying its product and panel', async () => {
    const made = await makeCatalog('alpha', { priceIrr: 2_500_000 });

    const res = await app.request(`/api/v1/admin/products?q=alpha`, {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{
        id: number;
        priceIrr: number;
        product: { id: number; name: string };
        provider: { id: number } | null;
      }>;
    };
    expect(body.total).toBe(1);
    const row = body.items[0]!;
    expect(row.id).toBe(made.planId);
    expect(row.priceIrr).toBe(2_500_000);
    expect(row.product.id).toBe(made.productId);
    expect(row.provider?.id).toBe(made.providerId);
  });

  it('keeps an unmetered plan unmetered rather than reporting zero', async () => {
    // NULL volume means "no cap"; 0 would mean "no traffic at all". Collapsing
    // one into the other is the kind of change a display layer makes quietly.
    await makeCatalog('unmetered', { volumeGb: null, durationDays: null });
    const res = await app.request('/api/v1/admin/products?q=unmetered', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: Array<{ volumeGb: number | null; durationDays: number | null }>;
    };
    expect(body.items[0]!.volumeGb).toBeNull();
    expect(body.items[0]!.durationDays).toBeNull();
  });

  it('filters by panel and by status, and pages in SQL', async () => {
    const a = await makeCatalog('filt-a');
    await makeCatalog('filt-b', { planStatus: 'DISABLED' });

    const byPanel = await app.request(
      `/api/v1/admin/products?providerId=${a.providerId}`,
      {},
      envAs(ADMIN),
    );
    const panelBody = (await byPanel.json()) as { total: number; items: Array<{ id: number }> };
    expect(panelBody.total).toBe(1);
    expect(panelBody.items[0]!.id).toBe(a.planId);

    const disabled = await app.request(
      '/api/v1/admin/products?q=filt-&status=DISABLED',
      {},
      envAs(ADMIN),
    );
    expect(((await disabled.json()) as { total: number }).total).toBe(1);

    const paged = await app.request(
      '/api/v1/admin/products?q=filt-&page=1&pageSize=1',
      {},
      envAs(ADMIN),
    );
    const pagedBody = (await paged.json()) as { total: number; items: unknown[] };
    expect(pagedBody.total).toBe(2);
    expect(pagedBody.items).toHaveLength(1);
  });

  it('is readable by a reviewer', async () => {
    await makeCatalog('readable');
    const res = await app.request('/api/v1/admin/products?q=readable', {}, envAs(REVIEWER));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/admin/products/plans/:id', () => {
  async function patch(id: number, body: unknown, email = ADMIN) {
    return app.request(
      `/api/v1/admin/products/plans/${id}`,
      { method: 'POST', body: JSON.stringify(body) },
      envAs(email),
    );
  }

  it('writes the price to the database and records who changed it', async () => {
    const { planId } = await makeCatalog('repricing', { priceIrr: 1_000_000 });

    const res = await patch(planId, { priceIrr: 1_800_000 });
    expect(res.status).toBe(200);

    // The database, not the response body.
    expect(Number((await planRow(planId))!.price_irr)).toBe(1_800_000);

    const logs = await auditRows('PRODUCT_PLAN', planId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('catalog.plan_updated');
    expect(logs[0]!.actor_email).toBe(ADMIN);
    expect(JSON.parse(logs[0]!.before_json).price_irr).toBe(1_000_000);
    expect(JSON.parse(logs[0]!.after_json).price_irr).toBe(1_800_000);
  });

  it('leaves fields the patch did not mention alone', async () => {
    const { planId } = await makeCatalog('partial', { priceIrr: 900_000, durationDays: 60 });
    await patch(planId, { status: 'HIDDEN' });
    const row = (await planRow(planId))!;
    expect(row.status).toBe('HIDDEN');
    expect(Number(row.price_irr)).toBe(900_000);
    expect(row.duration_days).toBe(60);
  });

  it('can make a plan unmetered, which is not the same as setting it to zero', async () => {
    const { planId } = await makeCatalog('to-unmetered', { volumeGb: 50 });
    await patch(planId, { volumeGb: null });
    expect((await planRow(planId))!.volume_gb).toBeNull();

    const { planId: other } = await makeCatalog('to-zero', { volumeGb: 50 });
    await patch(other, { volumeGb: 0 });
    expect(Number((await planRow(other))!.volume_gb)).toBe(0);
  });

  it('refuses a price above the ceiling and changes nothing', async () => {
    // The guard exists because a price is typed by hand and the failure is an
    // extra zero. 100,000,000 IRR is already 13× the priciest real product.
    const { planId } = await makeCatalog('ceiling', { priceIrr: 7_500_000 });

    const ok = await patch(planId, { priceIrr: MAX_SINGLE_PAYMENT_IRR });
    expect(ok.status).toBe(200);

    const tooMuch = await patch(planId, { priceIrr: MAX_SINGLE_PAYMENT_IRR + 1 });
    expect(tooMuch.status).toBe(400);
    expect(Number((await planRow(planId))!.price_irr)).toBe(MAX_SINGLE_PAYMENT_IRR);
  });

  it('refuses a negative price', async () => {
    const { planId } = await makeCatalog('negative', { priceIrr: 500_000 });
    expect((await patch(planId, { priceIrr: -1 })).status).toBe(400);
    expect(Number((await planRow(planId))!.price_irr)).toBe(500_000);
  });

  it('refuses an empty patch rather than writing an audit row saying nothing changed', async () => {
    const { planId } = await makeCatalog('empty-patch');
    expect((await patch(planId, {})).status).toBe(400);
    expect(await auditRows('PRODUCT_PLAN', planId)).toHaveLength(0);
  });

  it('refuses a field it does not know', async () => {
    const { planId } = await makeCatalog('unknown-field');
    expect((await patch(planId, { priceIrr: 100, providerId: 9 })).status).toBe(400);
  });

  it('is refused for a reviewer, and the price does not move', async () => {
    const { planId } = await makeCatalog('reviewer-price', { priceIrr: 640_000 });
    const res = await patch(planId, { priceIrr: 10 }, REVIEWER);
    expect(res.status).toBe(403);
    expect(Number((await planRow(planId))!.price_irr)).toBe(640_000);
    expect(await auditRows('PRODUCT_PLAN', planId)).toHaveLength(0);
  });

  it('404s on a plan that does not exist', async () => {
    expect((await patch(2_000_000_001, { priceIrr: 100 })).status).toBe(404);
  });

  it('can move a plan up the list and cap how many share it', async () => {
    // Two columns the panel had no write path for at all: a plan's position on
    // the customer's screen, and `user_limit`.
    const { planId } = await makeCatalog('ordering');
    expect((await patch(planId, { sortOrder: 7, userLimit: 3 })).status).toBe(200);
    const row = await baseEnv.DB.prepare(
      `SELECT sort_order, user_limit FROM product_plans WHERE id = ?1`,
    )
      .bind(planId)
      .first<{ sort_order: number; user_limit: number | null }>();
    expect(row!.sort_order).toBe(7);
    expect(row!.user_limit).toBe(3);
  });
});

describe('DELETE /api/v1/admin/products/plans/:id', () => {
  function del(id: number, email = ADMIN) {
    return app.request(`/api/v1/admin/products/plans/${id}`, { method: 'DELETE' }, envAs(email));
  }

  it('removes a plan nothing points at, and says so in the ledger', async () => {
    const { planId } = await makeCatalog('deletable');
    expect((await del(planId)).status).toBe(200);
    expect(await planRow(planId)).toBeNull();

    const logs = await auditRows('PRODUCT_PLAN', planId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('catalog.plan_deleted');
    // The row that is gone is written down before it goes; after is null.
    expect(JSON.parse(logs[0]!.before_json).name).toBe('پلن deletable');
    expect(logs[0]!.after_json).toBeNull();
  });

  it('refuses a plan an order points at, and names the count', async () => {
    const { planId } = await makeCatalog('sold');
    await placeOrder(planId, 991_000_001);

    const res = await del(planId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      detail: string;
      counts: { orders: number };
    };
    expect(body.error).toBe('in_use');
    expect(body.counts.orders).toBe(1);
    // Measured against `Intl`, not against a literal — the literal here used to
    // be `'1 سفارش'` in Latin digits, which is exactly what the route sent, so
    // the test agreed with the bug for as long as both existed. Found in a
    // browser on 2026-08-22: the refusal said «1 سفارش» under a paragraph on
    // the same screen saying «۱۲ سفارش».
    expect(body.detail).toContain(`${new Intl.NumberFormat('fa-IR').format(1)} سفارش`);
    expect(body.detail).not.toMatch(/[0-9]/);

    // And the order still knows what it bought — the failure this guard exists
    // to prevent is not an error, it is a silent NULL in `orders.plan_id`.
    expect(await planRow(planId)).not.toBeNull();
    const order = await baseEnv.DB.prepare(`SELECT plan_id FROM orders WHERE plan_id = ?1`)
      .bind(planId)
      .first<{ plan_id: number }>();
    expect(Number(order!.plan_id)).toBe(planId);
  });

  it('refuses a plan a sold subscription points at', async () => {
    const { planId, providerId } = await makeCatalog('subscribed');
    await giveSubscription(planId, providerId, 991_000_002);

    const res = await del(planId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { counts: { subscriptions: number } }).counts.subscriptions).toBe(
      1,
    );
    expect(await planRow(planId)).not.toBeNull();
  });

  it('refuses a plan with a config still on the shelf', async () => {
    const { planId, providerId } = await makeCatalog('stocked');
    await baseEnv.DB.prepare(
      `INSERT INTO provisioning_stock (plan_id, provider_id, remote_username, subscription_url)
       VALUES (?1, ?2, ?3, 'https://panel.test/sub/stocked')`,
    )
      .bind(planId, providerId, `${PREFIX}stocked-user`)
      .run();

    const res = await del(planId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { counts: { stock: number } }).counts.stock).toBe(1);
    expect(await planRow(planId)).not.toBeNull();
  });

  it('is refused for a reviewer', async () => {
    const { planId } = await makeCatalog('reviewer-delete');
    expect((await del(planId, REVIEWER)).status).toBe(403);
    expect(await planRow(planId)).not.toBeNull();
  });

  it('404s on a plan that does not exist', async () => {
    expect((await del(2_000_000_002)).status).toBe(404);
  });
});

describe('POST /api/v1/admin/products/:id/status', () => {
  it('takes a product off the shelf and records it', async () => {
    const { productId } = await makeCatalog('shelf');

    const res = await app.request(
      `/api/v1/admin/products/${productId}/status`,
      { method: 'POST', body: JSON.stringify({ status: 'DISABLED' }) },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(`SELECT status FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ status: string }>();
    expect(row!.status).toBe('DISABLED');

    const logs = await auditRows('PRODUCT', productId);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.before_json).status).toBe('ACTIVE');
    expect(JSON.parse(logs[0]!.after_json).status).toBe('DISABLED');
  });

  it('refuses a status the schema does not allow', async () => {
    const { productId } = await makeCatalog('bad-status');
    const res = await app.request(
      `/api/v1/admin/products/${productId}/status`,
      { method: 'POST', body: JSON.stringify({ status: 'DELETED' }) },
      envAs(ADMIN),
    );
    expect(res.status).toBe(400);
  });

  it('is refused for a reviewer', async () => {
    const { productId } = await makeCatalog('reviewer-shelf');
    const res = await app.request(
      `/api/v1/admin/products/${productId}/status`,
      { method: 'POST', body: JSON.stringify({ status: 'DISABLED' }) },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
    const row = await baseEnv.DB.prepare(`SELECT status FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ status: string }>();
    expect(row!.status).toBe('ACTIVE');
  });
});

describe('creating a product and its plans', () => {
  function post(path: string, body: unknown, email = ADMIN) {
    return app.request(
      `/api/v1/admin/${path}`,
      { method: 'POST', body: JSON.stringify(body) },
      envAs(email),
    );
  }

  /**
   * Switches the shop's custom-emoji setting on, and takes it off again after.
   *
   * The row is shared: every package in this workspace tests against ONE
   * Postgres, and `bot-content.test.ts` asserts that the bot's wording comes
   * back with the markup STRIPPED. Leaving this on turned that suite red from a
   * file it never mentions — rule 8, met in the wild.
   */
  async function withCustomEmojiOn(): Promise<void> {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'custom_emoji', 'true'::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = 'true'::jsonb`,
    ).run();
  }

  afterEach(async () => {
    await baseEnv.DB.prepare(
      `DELETE FROM settings WHERE scope = 'bot' AND key = 'custom_emoji'`,
    ).run();
  });

  /**
   * A custom emoji in a product NAME.
   *
   * The wording of the bot has been checked at the write path since the feature
   * shipped; a name never was, because a name is a column. From 2026-09-03 an
   * admin may put a tag in one, so the same `checkCustomEmoji` gate runs here —
   * and a malformed tag has to be refused rather than stored, because the only
   * other place it could be noticed is a customer's invoice.
   */
  it('refuses a malformed emoji tag in a product name', async () => {
    await withCustomEmojiOn();
    const provider = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind) VALUES (?1, 'پنل ایموجی', 'marzban')
       RETURNING id`,
    )
      .bind(`${PREFIX}emoji-prod`)
      .first<{ id: number }>();
    const cat = await post('product-categories', { name: `${PREFIX}دستهٔ ایموجی`, sortOrder: 3 });
    const categoryId = ((await cat.json()) as { category: { id: number } }).category.id;

    const res = await post('products', {
      code: `${PREFIX}emoji-broken`,
      name: '<tg-emoji emoji-id="abc">🔥</tg-emoji> پلاتینیوم',
      kind: 'vpn',
      providerId: provider!.id,
      categoryId,
    });

    expect(res.status).toBe(400);
    // Nothing was written: the refusal is the whole point.
    const row = await baseEnv.DB.prepare(`SELECT id FROM products WHERE code = ?1`)
      .bind(`${PREFIX}emoji-broken`)
      .first<{ id: number }>();
    expect(row).toBeNull();
  });

  it('stores a well-formed emoji tag in a product name', async () => {
    await withCustomEmojiOn();
    const provider = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind) VALUES (?1, 'پنل ایموجی ۲', 'marzban')
       RETURNING id`,
    )
      .bind(`${PREFIX}emoji-prod-ok`)
      .first<{ id: number }>();
    const cat = await post('product-categories', { name: `${PREFIX}دستهٔ ایموجی ۲`, sortOrder: 4 });
    const categoryId = ((await cat.json()) as { category: { id: number } }).category.id;

    const name = '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> پلاتینیوم';
    const res = await post('products', {
      code: `${PREFIX}emoji-ok`,
      name,
      kind: 'vpn',
      providerId: provider!.id,
      categoryId,
    });

    expect(res.status).toBe(201);
    // Read back from the table, not from the response.
    const row = await baseEnv.DB.prepare(`SELECT name FROM products WHERE code = ?1`)
      .bind(`${PREFIX}emoji-ok`)
      .first<{ name: string }>();
    expect(row?.name).toBe(name);
  });

  it('writes every field the panel had no way to set before', async () => {
    // These eight columns existed in `0002_catalog.sql` from the first day and
    // no route could write any of them: the panel could only edit five fields
    // of an already-imported plan.
    const provider = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind) VALUES (?1, 'پنل تازه', 'marzban')
       RETURNING id`,
    )
      .bind(`${PREFIX}new-prod`)
      .first<{ id: number }>();

    const cat = await post('product-categories', { name: `${PREFIX}دستهٔ تازه`, sortOrder: 2 });
    expect(cat.status).toBe(201);
    const categoryId = ((await cat.json()) as { category: { id: number } }).category.id;

    const res = await post('products', {
      code: `${PREFIX}fresh`,
      name: 'محصول تازه',
      kind: 'spotify',
      providerId: Number(provider!.id),
      categoryId,
      description: 'یک خط توضیح',
      resellersOnly: true,
      oncePerUser: true,
      sortOrder: 5,
      status: 'HIDDEN',
    });
    expect(res.status).toBe(201);
    const productId = ((await res.json()) as { productId: number }).productId;

    const row = await baseEnv.DB.prepare(
      `SELECT code, name, kind, provider_id, category_id, description,
              resellers_only, once_per_user, sort_order, status
         FROM products WHERE id = ?1`,
    )
      .bind(productId)
      .first<Record<string, unknown>>();
    expect(row!['code']).toBe(`${PREFIX}fresh`);
    expect(row!['kind']).toBe('spotify');
    expect(Number(row!['provider_id'])).toBe(Number(provider!.id));
    expect(Number(row!['category_id'])).toBe(categoryId);
    expect(row!['description']).toBe('یک خط توضیح');
    expect(row!['resellers_only']).toBe(true);
    expect(row!['once_per_user']).toBe(true);
    expect(row!['sort_order']).toBe(5);
    expect(row!['status']).toBe('HIDDEN');
  });

  it('makes a plan unmetered and undying by default rather than guessing', async () => {
    // The one thing a create form must not do is substitute 0 GB or 30 days
    // for "not filled in" — those are prices the shop never agreed to.
    const { productId } = await makeCatalog('defaults');
    const res = await post(`products/${productId}/plans`, {
      name: 'پلن نامحدود',
      priceIrr: 2_000_000,
    });
    expect(res.status).toBe(201);
    const plan = (await res.json()) as {
      plan: { id: number; volumeGb: number | null; durationDays: number | null; status: string };
    };
    expect(plan.plan.volumeGb).toBeNull();
    expect(plan.plan.durationDays).toBeNull();

    const row = (await planRow(plan.plan.id))!;
    expect(row.volume_gb).toBeNull();
    expect(row.duration_days).toBeNull();
    expect(row.status).toBe('ACTIVE');
  });

  it('sells the new plan through the same list the panel reads', async () => {
    const { productId } = await makeCatalog('listed');
    await post(`products/${productId}/plans`, {
      name: 'پلن دوم',
      priceIrr: 3_300_000,
      durationDays: 90,
      volumeGb: 120,
    });
    const list = await app.request('/api/v1/admin/products?q=listed', {}, envAs(ADMIN));
    const body = (await list.json()) as { total: number; items: Array<{ name: string }> };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.name)).toContain('پلن دوم');
  });

  it('refuses a duplicate code instead of raising', async () => {
    await makeCatalog('dupe');
    const res = await post('products', {
      code: `${PREFIX}dupe`,
      name: 'محصول تکراری',
      kind: 'vpn',
      categoryId: CATEGORY,
    });
    expect(res.status).toBe(409);
  });

  it('refuses a panel that does not exist instead of raising', async () => {
    const res = await post('products', {
      code: `${PREFIX}ghost-panel`,
      name: 'محصول بی‌پنل',
      kind: 'vpn',
      categoryId: CATEGORY,
      providerId: 2_000_000_003,
    });
    expect(res.status).toBe(409);
  });

  it('refuses a code with a space in it', async () => {
    // `products.code` is UNIQUE and joined on in every report; free text there
    // reads as two columns downstream.
    expect(
      (await post('products', { code: `${PREFIX}two words`, name: 'x', kind: 'vpn' })).status,
    ).toBe(400);
  });

  it('refuses a price above the ceiling on create, not only on edit', async () => {
    const { productId } = await makeCatalog('create-ceiling');
    const res = await post(`products/${productId}/plans`, {
      name: 'پلن گران',
      priceIrr: MAX_SINGLE_PAYMENT_IRR + 1,
    });
    expect(res.status).toBe(400);
  });

  it('404s when the product a plan is added to does not exist', async () => {
    expect((await post('products/2000000004/plans', { name: 'x', priceIrr: 1000 })).status).toBe(
      404,
    );
  });

  it('is refused for a reviewer, and nothing is written', async () => {
    const res = await post('products', { code: `${PREFIX}rev`, name: 'x', kind: 'vpn' }, REVIEWER);
    expect(res.status).toBe(403);
    const row = await baseEnv.DB.prepare(`SELECT id FROM products WHERE code = ?1`)
      .bind(`${PREFIX}rev`)
      .first();
    expect(row).toBeNull();
  });
});

describe('POST /api/v1/admin/products/:id', () => {
  function edit(id: number, body: unknown, email = ADMIN) {
    return app.request(
      `/api/v1/admin/products/${id}`,
      { method: 'POST', body: JSON.stringify(body) },
      envAs(email),
    );
  }

  it('moves a product to another panel and records both sides', async () => {
    const { productId } = await makeCatalog('moving');
    const other = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind) VALUES (?1, 'مقصد', 'hiddify')
       RETURNING id`,
    )
      .bind(`${PREFIX}dest`)
      .first<{ id: number }>();

    expect((await edit(productId, { providerId: Number(other!.id) })).status).toBe(200);
    const row = await baseEnv.DB.prepare(`SELECT provider_id FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ provider_id: number }>();
    expect(Number(row!.provider_id)).toBe(Number(other!.id));

    const logs = await auditRows('PRODUCT', productId);
    expect(logs[0]!.action).toBe('catalog.product_updated');
    expect(JSON.parse(logs[0]!.after_json).provider_id).toBe(Number(other!.id));
  });

  it('can take a product off a panel entirely', async () => {
    const { productId } = await makeCatalog('unpanelled');
    expect((await edit(productId, { providerId: null })).status).toBe(200);
    const row = await baseEnv.DB.prepare(`SELECT provider_id FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ provider_id: number | null }>();
    expect(row!.provider_id).toBeNull();
  });

  it('refuses an empty patch and a field it does not know', async () => {
    const { productId } = await makeCatalog('strict');
    expect((await edit(productId, {})).status).toBe(400);
    expect((await edit(productId, { priceIrr: 5 })).status).toBe(400);
  });

  it('writes the tier a service delivers into, and reads it back', async () => {
    // «پلاتینیوم» is a product pointed at a group on the panel. Until this
    // field existed there was nowhere to point it: `group_ids` was readable on
    // the panel row and on one plan's `attrs`, and no route wrote either — so
    // one panel could sell exactly one level however many groups it had.
    const { productId, providerId } = await makeCatalog('tier');
    expect((await edit(productId, { groupIds: [6, 7] })).status).toBe(200);

    // Read from `products.attrs`, not from the response. The response would
    // pass this test by echoing the request back.
    const row = await baseEnv.DB.prepare(`SELECT attrs FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ attrs: Record<string, unknown> }>();
    expect(row!.attrs['group_ids']).toEqual([6, 7]);

    const listed = await app.request(
      `/api/v1/admin/products?providerId=${providerId}`,
      {},
      envAs(ADMIN),
    );
    const items = (await listed.json()) as {
      items: Array<{ product: { id: number; groupIds: number[] | null } }>;
    };
    expect(items.items.find((i) => i.product.id === productId)?.product.groupIds).toEqual([6, 7]);
  });

  it('tells «no groups at all» apart from «the panel decides»', async () => {
    // Two different instructions that a single field would collapse into one.
    // `[]` sends an empty list; null takes the key OUT so `pick()` falls
    // through to the panel — and an operator who cleared the boxes must not
    // silently keep selling the old tier.
    const { productId } = await makeCatalog('tier-clear');
    await edit(productId, { groupIds: [6] });

    expect((await edit(productId, { groupIds: [] })).status).toBe(200);
    const emptied = await baseEnv.DB.prepare(`SELECT attrs FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ attrs: Record<string, unknown> }>();
    expect(emptied!.attrs['group_ids']).toEqual([]);

    expect((await edit(productId, { groupIds: null })).status).toBe(200);
    const cleared = await baseEnv.DB.prepare(`SELECT attrs FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ attrs: Record<string, unknown> }>();
    expect(cleared!.attrs).not.toHaveProperty('group_ids');
  });

  it('leaves the rest of `attrs` alone when only the tier changes', async () => {
    // `attrs` is the adapter's bag and migrated rows carry more than groups in
    // it. An overwrite here would drop whatever else the importer wrote.
    const { productId } = await makeCatalog('tier-merge');
    await baseEnv.DB.prepare(
      `UPDATE products SET attrs = jsonb_build_object('proxies', '["vless"]'::jsonb) WHERE id = ?1`,
    )
      .bind(productId)
      .run();

    await edit(productId, { groupIds: [4] });
    const row = await baseEnv.DB.prepare(`SELECT attrs FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ attrs: Record<string, unknown> }>();
    expect(row!.attrs['proxies']).toEqual(['vless']);
    expect(row!.attrs['group_ids']).toEqual([4]);
  });

  it('is refused for a reviewer', async () => {
    const { productId } = await makeCatalog('reviewer-edit');
    expect((await edit(productId, { name: 'تغییر' }, REVIEWER)).status).toBe(403);
  });
});

describe('DELETE /api/v1/admin/products/:id', () => {
  function del(id: number, email = ADMIN) {
    return app.request(`/api/v1/admin/products/${id}`, { method: 'DELETE' }, envAs(email));
  }

  async function productRow(id: number) {
    return baseEnv.DB.prepare(`SELECT id FROM products WHERE id = ?1`).bind(id).first();
  }

  it('removes a product and its plans when nothing points at them', async () => {
    const { productId, planId } = await makeCatalog('removable');
    expect((await del(productId)).status).toBe(200);
    expect(await productRow(productId)).toBeNull();
    // `product_plans.product_id` is ON DELETE CASCADE; the plan goes with it.
    expect(await planRow(planId)).toBeNull();
  });

  it('refuses a product whose plan carries an order, one join further out', async () => {
    // The guard on a product has to reach through `product_plans`, because
    // deleting the product cascades the plan away and the order's `plan_id`
    // would be SET NULL on the way past.
    const { productId, planId } = await makeCatalog('sold-product');
    await placeOrder(planId, 991_000_010);

    const res = await del(productId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { counts: { orders: number } }).counts.orders).toBe(1);
    expect(await productRow(productId)).not.toBeNull();
    expect(await planRow(planId)).not.toBeNull();
  });

  it('refuses a product a discount code is scoped to', async () => {
    // `discount_codes.product_id` is CASCADE and `discount_redemptions` cascades
    // from the code — so this delete would reach a record of money given.
    const { productId } = await makeCatalog('discounted');
    await baseEnv.DB.prepare(
      `INSERT INTO discount_codes (code, kind, percent) VALUES (?1, 'PERCENT_OFF', 20)`,
    )
      .bind(`${PREFIX}code`)
      .run();
    await baseEnv.DB.prepare(`UPDATE discount_codes SET product_id = ?1 WHERE code = ?2`)
      .bind(productId, `${PREFIX}code`)
      .run();

    const res = await del(productId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { counts: { discounts: number } }).counts.discounts).toBe(1);
  });

  it('is refused for a reviewer, and 404s on a product that is not there', async () => {
    const { productId } = await makeCatalog('reviewer-del');
    expect((await del(productId, REVIEWER)).status).toBe(403);
    expect(await productRow(productId)).not.toBeNull();
    expect((await del(2_000_000_005)).status).toBe(404);
  });
});

describe('product categories', () => {
  it('lists them with how many products each holds', async () => {
    const made = await app.request(
      '/api/v1/admin/product-categories',
      { method: 'POST', body: JSON.stringify({ name: `${PREFIX}شمارش` }) },
      envAs(ADMIN),
    );
    const categoryId = ((await made.json()) as { category: { id: number } }).category.id;
    const { productId } = await makeCatalog('categorised');
    await app.request(
      `/api/v1/admin/products/${productId}`,
      { method: 'POST', body: JSON.stringify({ categoryId }) },
      envAs(ADMIN),
    );

    const res = await app.request('/api/v1/admin/product-categories', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: Array<{ id: number; name: string; productsCount: number }>;
    };
    const mine = body.items.find((i) => i.id === categoryId);
    expect(mine!.productsCount).toBe(1);
  });

  it('refuses a second category with the same name', async () => {
    const body = JSON.stringify({ name: `${PREFIX}تکراری` });
    const first = await app.request(
      '/api/v1/admin/product-categories',
      { method: 'POST', body },
      envAs(ADMIN),
    );
    expect(first.status).toBe(201);
    const again = await app.request(
      '/api/v1/admin/product-categories',
      { method: 'POST', body },
      envAs(ADMIN),
    );
    expect(again.status).toBe(409);
  });
});
