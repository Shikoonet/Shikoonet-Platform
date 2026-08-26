/**
 * The routes behind the shop's categories and its arrangement.
 *
 * Nothing here trusts the response about what was written. Every assertion
 * re-reads `product_categories` / `product_plans` in a separate query, for the
 * reason `products.test.ts` opens with: a route that echoed its request body
 * back would pass a test that compared the reply to what was sent.
 *
 * Three properties earn most of the file, and all three are about the SAVE
 * refusing something rather than the save working:
 *
 *   1. **A save addressed to one screen cannot move another one.** The scope's
 *      membership is read out of Postgres, never taken from the request.
 *   2. **A save must name the whole screen.** Half a screen leaves the other
 *      half on yesterday's numbers and the two interleave — not the old order
 *      and not the new one, with nothing anywhere reporting an error.
 *   3. **Nothing moves a primary key.** The whole distance between this and
 *      `faoxima/panel/product.php:68-74`, which reorders by swapping `id`s and
 *      thereby repoints every `plan:<id>` already sitting in a customer's chat.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin@example.com';
const PREFIX = 'zz-layout-';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function post(path: string, body: unknown, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    }),
    envAs(email),
  );
}

async function del(path: string, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'DELETE',
      headers: { origin: 'http://localhost' },
    }),
    envAs(email),
  );
}

async function get(path: string, email = ADMIN): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), envAs(email));
}

/** A category of this suite's own, findable again by its prefixed name. */
async function makeCategory(label: string, sortOrder = 0): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO product_categories (name, sort_order) VALUES (?1, ?2) RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, sortOrder)
    .first<{ id: number }>();
  return Number(row!.id);
}

/** One product in that category, carrying `count` configs. */
async function makeConfigs(categoryId: number, label: string, count: number): Promise<number[]> {
  const product = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, category_id, status)
     VALUES (?1, ?2, 'vpn', ?3, 'ACTIVE') RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, `محصول ${label}`, categoryId)
    .first<{ id: number }>();
  const productId = Number(product!.id);

  const ids: number[] = [];
  for (let n = 0; n < count; n += 1) {
    const plan = await baseEnv.DB.prepare(
      `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, sort_order)
       VALUES (?1, ?2, ?3, 30, 50, ?4) RETURNING id`,
    )
      .bind(productId, `${label} ${n}`, 100_000 * (n + 1), n)
      .first<{ id: number }>();
    ids.push(Number(plan!.id));
  }
  return ids;
}

/** `(id, row_index, sort_order)` for a set of configs, as Postgres holds them. */
async function readPlans(ids: number[]): Promise<Record<number, [number | null, number]>> {
  const holes = ids.map((_, i) => `?${i + 1}`).join(', ');
  const rows = await baseEnv.DB.prepare(
    `SELECT id, row_index, sort_order FROM product_plans WHERE id IN (${holes})`,
  )
    .bind(...ids)
    .all<{ id: number; row_index: number | null; sort_order: number }>();
  const out: Record<number, [number | null, number]> = {};
  for (const r of rows.results ?? []) {
    out[Number(r.id)] = [r.row_index === null ? null : Number(r.row_index), Number(r.sort_order)];
  }
  return out;
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM product_categories WHERE name LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
}

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), ADMIN, Date.now())
    .run();
});

beforeEach(purge);
afterAll(purge);

describe('saving an arrangement', () => {
  it('writes the array position into sort_order and leaves every id alone', async () => {
    // The array's ORDER is the whole of the horizontal order; `sort_order` is
    // never sent. And the ids are read back and compared, because the panel
    // this replaces reorders by swapping them.
    const cat = await makeCategory('a');
    const ids = await makeConfigs(cat, 'a', 4);

    const reordered = [ids[3]!, ids[0]!, ids[1]!, ids[2]!];
    const res = await post(`/api/v1/admin/catalog-layout/category:${cat}`, {
      items: [
        { id: reordered[0], rowIndex: 0 },
        { id: reordered[1], rowIndex: 0 },
        { id: reordered[2], rowIndex: 1 },
        { id: reordered[3], rowIndex: 2 },
      ],
    });
    expect(res.status).toBe(200);

    const after = await readPlans(ids);
    expect(Object.keys(after).map(Number).sort()).toEqual([...ids].sort());
    expect(after[reordered[0]!]).toEqual([0, 0]);
    expect(after[reordered[1]!]).toEqual([0, 1]);
    expect(after[reordered[2]!]).toEqual([1, 2]);
    expect(after[reordered[3]!]).toEqual([2, 3]);
  });

  it('refuses a config that belongs to another category, and leaves that category alone', async () => {
    // The trust boundary. Without the scope being re-derived from Postgres,
    // this post reorders a screen it does not address.
    const mine = await makeCategory('mine');
    const theirs = await makeCategory('theirs');
    const ours = await makeConfigs(mine, 'mine', 2);
    const stranger = await makeConfigs(theirs, 'theirs', 2);
    const before = await readPlans(stranger);

    const res = await post(`/api/v1/admin/catalog-layout/category:${mine}`, {
      items: [
        { id: ours[0], rowIndex: 0 },
        { id: ours[1], rowIndex: 0 },
        { id: stranger[0], rowIndex: 1 },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'FOREIGN_ID' });
    expect(await readPlans(stranger)).toEqual(before);
    // …and nothing of ours moved either: the batch is all or nothing.
    const untouched = await readPlans(ours);
    expect(untouched[ours[0]!]![0]).toBeNull();
  });

  it('refuses a save that names only part of the screen', async () => {
    // Three of five, saved: the other two keep yesterday's `sort_order` and
    // interleave with the new one. What comes out is neither order, and no
    // error is raised anywhere — which is why this is refused rather than
    // repaired.
    const cat = await makeCategory('partial');
    const ids = await makeConfigs(cat, 'partial', 5);

    const res = await post(`/api/v1/admin/catalog-layout/category:${cat}`, {
      items: [
        { id: ids[0], rowIndex: 0 },
        { id: ids[1], rowIndex: 0 },
        { id: ids[2], rowIndex: 1 },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { kind: string; detail: string };
    expect(body.kind).toBe('MISSING_ID');
    // The refusal names the rows it is missing, in Persian digits.
    expect(body.detail).toContain('کلِ صفحه');

    const after = await readPlans(ids);
    for (const id of ids) expect(after[id]![0]).toBeNull();
  });

  it('counts a HIDDEN config as part of the screen', async () => {
    // The admin arranges what they can see, and what they can see includes the
    // config they disabled last week. If the scope were ACTIVE-only, every save
    // on a category holding one would come back MISSING_ID.
    const cat = await makeCategory('hidden');
    const ids = await makeConfigs(cat, 'hidden', 3);
    await baseEnv.DB.prepare(`UPDATE product_plans SET status = 'HIDDEN' WHERE id = ?1`)
      .bind(ids[1])
      .run();

    const res = await post(`/api/v1/admin/catalog-layout/category:${cat}`, {
      items: ids.map((id) => ({ id, rowIndex: 0 })),
    });
    expect(res.status).toBe(200);
    expect((await readPlans(ids))[ids[1]!]).toEqual([0, 1]);
  });

  it('refuses a row wider than Telegram accepts', async () => {
    const cat = await makeCategory('wide');
    const ids = await makeConfigs(cat, 'wide', 9);
    const res = await post(`/api/v1/admin/catalog-layout/category:${cat}`, {
      items: ids.map((id) => ({ id, rowIndex: 0 })),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'ROW_TOO_WIDE' });
  });

  it('arranges the categories themselves, on the same route', async () => {
    // The first screen of the shop is a list of categories, so it needs the
    // same two columns. One route, two scopes — the alternative is a second
    // endpoint that has to be kept saying the same thing as this one.
    const first = await makeCategory('one', 10);
    const second = await makeCategory('two', 11);
    const all = await baseEnv.DB.prepare(`SELECT id FROM product_categories`).all<{ id: number }>();
    const everyId = (all.results ?? []).map((r) => Number(r.id));
    // The whole screen, with this suite's two at the front on one row.
    const rest = everyId.filter((id) => id !== first && id !== second);
    const items = [
      { id: first, rowIndex: 0 },
      { id: second, rowIndex: 0 },
      ...rest.map((id, at) => ({ id, rowIndex: at + 1 })),
    ];

    const res = await post('/api/v1/admin/catalog-layout/categories', { items });
    expect(res.status).toBe(200);

    const rows = await baseEnv.DB.prepare(
      `SELECT id, row_index, sort_order FROM product_categories WHERE id IN (?1, ?2)`,
    )
      .bind(first, second)
      .all<{ id: number; row_index: number; sort_order: number }>();
    const byId = new Map((rows.results ?? []).map((r) => [Number(r.id), r]));
    expect(Number(byId.get(first)!.row_index)).toBe(0);
    expect(Number(byId.get(first)!.sort_order)).toBe(0);
    expect(Number(byId.get(second)!.row_index)).toBe(0);
    expect(Number(byId.get(second)!.sort_order)).toBe(1);
  });

  it('does not invent a scope', async () => {
    const res = await post('/api/v1/admin/catalog-layout/plans', { items: [{ id: 1, rowIndex: 0 }] });
    expect(res.status).toBe(404);
  });
});

describe('a category', () => {
  it('can be renamed and switched off, and the change is in the database', async () => {
    const id = await makeCategory('edit');
    const res = await post(`/api/v1/admin/product-categories/${id}`, {
      name: `${PREFIX}edited`,
      emoji: '🇩🇪',
      active: false,
    });
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT name, emoji, active FROM product_categories WHERE id = ?1`,
    )
      .bind(id)
      .first<{ name: string; emoji: string | null; active: boolean }>();
    expect(row).toMatchObject({ name: `${PREFIX}edited`, emoji: '🇩🇪', active: false });
  });

  it('cannot take a name another category already has', async () => {
    const a = await makeCategory('dup-a');
    await makeCategory('dup-b');
    const res = await post(`/api/v1/admin/product-categories/${a}`, { name: `${PREFIX}dup-b` });
    expect(res.status).toBe(409);
  });

  it('refuses to be deleted while a product names it, and says how many', async () => {
    // `products.category_id` is NOT NULL with ON DELETE RESTRICT, so Postgres
    // refuses this on its own. The clause inside the DELETE is what turns that
    // into a sentence with a number instead of a driver error — and the
    // products are re-read afterwards to prove nothing was half-done.
    const id = await makeCategory('busy');
    await makeConfigs(id, 'busy', 2);

    const res = await del(`/api/v1/admin/product-categories/${id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string; counts: { products: number } };
    expect(body.counts.products).toBe(1);
    expect(body.detail).toContain('۱ محصول');

    const still = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM products WHERE category_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(still!.n).toBe(1);
  });

  it('is deleted once nothing points at it', async () => {
    const id = await makeCategory('empty');
    expect((await del(`/api/v1/admin/product-categories/${id}`)).status).toBe(200);
    const gone = await baseEnv.DB.prepare(`SELECT id FROM product_categories WHERE id = ?1`)
      .bind(id)
      .first();
    expect(gone).toBeNull();
  });

  it('carries its emoji, switch and row through the list route', async () => {
    const id = await makeCategory('listed');
    await baseEnv.DB.prepare(
      `UPDATE product_categories SET emoji = '🎧', active = false, row_index = 2 WHERE id = ?1`,
    )
      .bind(id)
      .run();
    const body = (await (await get('/api/v1/admin/product-categories')).json()) as {
      items: { id: number; emoji: string | null; active: boolean; rowIndex: number | null }[];
    };
    const mine = body.items.find((i) => i.id === id);
    expect(mine).toMatchObject({ emoji: '🎧', active: false, rowIndex: 2 });
  });
});

describe('the flat catalogue list', () => {
  it('filters by category on the server, not on the page it already sent', async () => {
    const mine = await makeCategory('filter-mine');
    const other = await makeCategory('filter-other');
    const ours = await makeConfigs(mine, 'filter-mine', 2);
    await makeConfigs(other, 'filter-other', 3);

    const body = (await (
      await get(`/api/v1/admin/products?categoryId=${mine}&pageSize=100`)
    ).json()) as { total: number; items: { id: number }[] };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id).sort()).toEqual([...ours].sort());
  });

  it('tells «only resellers» apart from «not asked»', async () => {
    // `?resellersOnly=false` is a real question — «what does an ordinary
    // customer see» — and has to be askable separately from not asking.
    const cat = await makeCategory('resellers');
    const open = await makeConfigs(cat, 'resellers-open', 1);
    const closed = await makeConfigs(cat, 'resellers-closed', 1);
    await baseEnv.DB.prepare(
      `UPDATE products SET resellers_only = true WHERE code = ?1`,
    )
      .bind(`${PREFIX}resellers-closed`)
      .run();

    const only = (await (
      await get(`/api/v1/admin/products?categoryId=${cat}&resellersOnly=true&pageSize=100`)
    ).json()) as { items: { id: number }[] };
    const ordinary = (await (
      await get(`/api/v1/admin/products?categoryId=${cat}&resellersOnly=false&pageSize=100`)
    ).json()) as { items: { id: number }[] };
    const both = (await (
      await get(`/api/v1/admin/products?categoryId=${cat}&pageSize=100`)
    ).json()) as { items: { id: number }[] };

    expect(only.items.map((i) => i.id)).toEqual(closed);
    expect(ordinary.items.map((i) => i.id)).toEqual(open);
    expect(both.items).toHaveLength(2);
  });
});
