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

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { PLAN_MAX_PRICE_IRR } from '../src/productRoutes.js';

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
    `INSERT INTO products (code, name, kind, provider_id, status, resellers_only)
     VALUES (?1, ?2, 'vpn', ?3, ?4, ?5) RETURNING id`,
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
  // Plans cascade from products; products and providers go by their prefix.
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
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

    const ok = await patch(planId, { priceIrr: PLAN_MAX_PRICE_IRR });
    expect(ok.status).toBe(200);

    const tooMuch = await patch(planId, { priceIrr: PLAN_MAX_PRICE_IRR + 1 });
    expect(tooMuch.status).toBe(400);
    expect(Number((await planRow(planId))!.price_irr)).toBe(PLAN_MAX_PRICE_IRR);
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

  it('offers no way to delete a plan', async () => {
    // Deliberate: `orders.plan_id` is ON DELETE SET NULL, so a delete would
    // silently detach the sales history. DISABLED is the supported retirement.
    const { planId } = await makeCatalog('no-delete');
    const res = await app.request(
      `/api/v1/admin/products/plans/${planId}`,
      { method: 'DELETE' },
      envAs(ADMIN),
    );
    expect(res.status).toBe(404);
    expect(await planRow(planId)).not.toBeNull();
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
