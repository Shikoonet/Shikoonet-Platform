/**
 * `GET /api/v1/admin/catalog` — the shop as it is sold, not as it is stored.
 *
 * The route this replaces on screen (`GET /products`) answers one row per plan.
 * That shape is what made the catalogue screen unreadable: the service — the
 * thing a customer picks FIRST — was never a row, and paging by plan could cut
 * one service across two pages so half its configs were on the page you were
 * not looking at.
 *
 * So the assertions here are about the shape and the paging unit, and they are
 * made against rows this file inserts directly rather than against anything the
 * route echoed back.
 *
 * Same prefix discipline as `products.test.ts`: every row this suite makes
 * carries a code nothing else uses, and the purge goes by that prefix. This
 * package truncates enough already.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-catalog@example.com';
const PREFIX = 'zz-catalog-test-';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

interface ConfigSpec {
  name: string;
  priceIrr?: number;
  volumeGb?: number | null;
  durationDays?: number | null;
  status?: string;
  sortOrder?: number;
}

async function makePanel(label: string, sortOrder = 0): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, sort_order)
     VALUES (?1, ?2, 'marzban', 'ACTIVE', ?3) RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, `پنل ${label}`, sortOrder)
    .first<{ id: number }>();
  return Number(row!.id);
}

/** One service with its configs, built the way the new screen builds one. */
async function makeService(
  label: string,
  opts: {
    panelId?: number | null;
    groupIds?: number[] | null;
    status?: string;
    sortOrder?: number;
    configs?: ConfigSpec[];
  } = {},
): Promise<number> {
  const attrs = opts.groupIds == null ? '{}' : JSON.stringify({ group_ids: opts.groupIds });
  const row = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, provider_id, category_id, status, sort_order, attrs)
     VALUES (?1, ?2, 'vpn', ?3, (SELECT id FROM product_categories WHERE name = '__fixture'), ?4, ?5, ?6::jsonb) RETURNING id`,
  )
    .bind(
      `${PREFIX}${label}`,
      `سرویس ${label}`,
      opts.panelId ?? null,
      opts.status ?? 'ACTIVE',
      opts.sortOrder ?? 0,
      attrs,
    )
    .first<{ id: number }>();
  const productId = Number(row!.id);

  for (const cf of opts.configs ?? []) {
    await baseEnv.DB.prepare(
      `INSERT INTO product_plans
         (product_id, name, price_irr, duration_days, volume_gb, status, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        productId,
        cf.name,
        cf.priceIrr ?? 1_000_000,
        cf.durationDays === undefined ? 30 : cf.durationDays,
        cf.volumeGb === undefined ? 20 : cf.volumeGb,
        cf.status ?? 'ACTIVE',
        cf.sortOrder ?? 0,
      )
      .run();
  }
  return productId;
}

async function purge(): Promise<void> {
  for (const sql of [
    `DELETE FROM products WHERE code LIKE ?1`,
    `DELETE FROM provisioning_providers WHERE code LIKE ?1`,
  ]) {
    await baseEnv.DB.prepare(sql).bind(`${PREFIX}%`).run();
  }
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

beforeEach(purge);
afterAll(purge);

/** Only what these tests read. Written out so a shape change here goes red. */
interface CatalogItem {
  id: number;
  name: string;
  groupIds: number[] | null;
  panel: { id: number; name: string } | null;
  configs: Array<{ id: number; name: string; priceIrr: number; status: string }>;
}

interface CatalogBody {
  ok: boolean;
  total: number;
  items: CatalogItem[];
  panels: Array<{ id: number; name: string }>;
}

async function get(query: string, email = ADMIN) {
  const res = await app.request(`/api/v1/admin/catalog?${query}`, {}, envAs(email));
  return { status: res.status, body: (await res.json()) as CatalogBody };
}

describe('GET /api/v1/admin/catalog', () => {
  it('returns one item per service with its configs inside it', async () => {
    const panelId = await makePanel('one');
    await makeService('طلایی', {
      panelId,
      groupIds: [7],
      configs: [
        { name: '۱ ماهه - ۱۰ گیگ', priceIrr: 1_000_000, volumeGb: 10, sortOrder: 1 },
        { name: '۱ ماهه - ۲۰ گیگ', priceIrr: 2_000_000, volumeGb: 20, sortOrder: 2 },
        { name: '۱ ماهه - ۳۰ گیگ', priceIrr: 3_000_000, volumeGb: 30, sortOrder: 3 },
      ],
    });

    const { status, body } = await get(`q=${encodeURIComponent('طلایی')}`);
    expect(status).toBe(200);

    // One row, not three. This is the whole point of the route.
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);

    const service = body.items[0]!;
    expect(service.name).toBe('سرویس طلایی');
    expect(service.groupIds).toEqual([7]);
    expect(service.panel?.name).toBe('پنل one');
    expect(service.configs.map((cf) => cf.name)).toEqual([
      '۱ ماهه - ۱۰ گیگ',
      '۱ ماهه - ۲۰ گیگ',
      '۱ ماهه - ۳۰ گیگ',
    ]);
    expect(service.configs.map((cf) => cf.priceIrr)).toEqual([
      1_000_000, 2_000_000, 3_000_000,
    ]);
  });

  it('pages by service, so a service is never split across two pages', async () => {
    const panelId = await makePanel('two');
    // Three services of three configs each. Paged by PLAN, page 1 of 2 would
    // hold service A and two thirds of service B — the exact failure.
    for (const [i, label] of ['aa', 'bb', 'cc'].entries()) {
      await makeService(label, {
        panelId,
        sortOrder: i,
        configs: [{ name: `${label}-1` }, { name: `${label}-2` }, { name: `${label}-3` }],
      });
    }

    const first = await get(`q=${encodeURIComponent(PREFIX)}&page=1&pageSize=2`);
    expect(first.body.total).toBe(3);
    expect(first.body.items).toHaveLength(2);
    for (const service of first.body.items) {
      expect(service.configs).toHaveLength(3);
    }

    const second = await get(`q=${encodeURIComponent(PREFIX)}&page=2&pageSize=2`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0]!.configs).toHaveLength(3);
  });

  it('carries a disabled config too, because that is usually why the service was opened', async () => {
    const panelId = await makePanel('three');
    await makeService('mixed', {
      panelId,
      configs: [
        { name: 'زنده', status: 'ACTIVE', sortOrder: 1 },
        { name: 'خاموش', status: 'DISABLED', sortOrder: 2 },
      ],
    });

    const { body } = await get(`q=${encodeURIComponent('mixed')}`);
    expect(body.items[0]!.configs.map((cf) => cf.status)).toEqual([
      'ACTIVE',
      'DISABLED',
    ]);
  });

  it('filters on the SERVICE status, not on a config status', async () => {
    const panelId = await makePanel('four');
    // A live service whose only config is switched off. Filtering by the plan's
    // status — which is what the flat route's `status` means — would drop it,
    // and the operator would go looking for a service they can see in the bot's
    // admin list and not here.
    await makeService('live', {
      panelId,
      status: 'ACTIVE',
      configs: [{ name: 'off', status: 'DISABLED' }],
    });
    await makeService('hidden', {
      panelId,
      status: 'HIDDEN',
      configs: [{ name: 'on', status: 'ACTIVE' }],
    });

    const active = await get(`q=${encodeURIComponent(PREFIX)}&status=ACTIVE`);
    expect(active.body.items.map((s) => s.name)).toEqual(['سرویس live']);

    const hidden = await get(`q=${encodeURIComponent(PREFIX)}&status=HIDDEN`);
    expect(hidden.body.items.map((s) => s.name)).toEqual(['سرویس hidden']);
  });

  it('lists a service with no panel, and says it has none', async () => {
    // It cannot be sold — the bot INNER JOINs the panel — so hiding it here
    // would make a service that is invisible in the shop also invisible in the
    // place you would go to fix it.
    await makeService('orphan', { panelId: null, configs: [{ name: 'x' }] });

    const { body } = await get(`q=${encodeURIComponent('orphan')}`);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.panel).toBeNull();
  });

  it('finds a service by the name of a config inside it', async () => {
    const panelId = await makePanel('five');
    await makeService('پلاتینیوم', {
      panelId,
      configs: [{ name: 'سه‌ماهه ۱۵۰ گیگ' }],
    });

    const { body } = await get(`q=${encodeURIComponent('۱۵۰ گیگ')}`);
    expect(body.items.map((s) => s.name)).toEqual(['سرویس پلاتینیوم']);
  });

  it('is readable by a REVIEWER, like the rest of the catalogue', async () => {
    const panelId = await makePanel('six');
    await makeService('readable', { panelId, configs: [{ name: 'c' }] });

    const { status, body } = await get(`q=${encodeURIComponent('readable')}`, REVIEWER);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });
});
