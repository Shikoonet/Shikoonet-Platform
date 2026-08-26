/**
 * قفسهٔ انبار, from the panel.
 *
 * The shelf is the one table where the ROW is the product: a `subscription_url`
 * here is a working account the moment it is handed to a customer. So the
 * assertions are about the three ways that goes wrong — a config filed against
 * a plan on another panel, a sold row being edited away, and the link reaching
 * somebody who is only counting stock.
 *
 * The bot's side of this — selling from the shelf, one config to one order — is
 * held by `apps/bot/test/stock.test.ts` against the same indexes. This file is
 * only about filling it.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-stock@example.com';
const REVIEWER = 'reviewer-stock@example.com';
const PREFIX = 'zz-stock-';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

interface Fixture {
  planA: number;
  planB: number;
  panelA: number;
  panelB: number;
}

let fx: Fixture;

async function makeCatalogue(): Promise<Fixture> {
  const panel = async (label: string) => {
    const r = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url)
       VALUES (?1, ?2, 'pasarguard', 'ACTIVE', 'https://panel.invalid') RETURNING id`,
    )
      .bind(`${PREFIX}${label}`, `پنل ${label}`)
      .first<{ id: number }>();
    return Number(r!.id);
  };
  const plan = async (label: string, providerId: number) => {
    const p = await baseEnv.DB.prepare(
      // `products.kind` is what is being SOLD ('vpn'), not the panel software
      // that delivers it — that lives on `provisioning_providers.kind`. The two
      // columns share a name and nothing else.
      `INSERT INTO products (code, name, kind, provider_id, category_id, status)
       VALUES (?1, ?2, 'vpn', ?3, (SELECT id FROM product_categories WHERE name = '__fixture'), 'ACTIVE') RETURNING id`,
    )
      .bind(`${PREFIX}${label}`, `محصول ${label}`, providerId)
      .first<{ id: number }>();
    const pl = await baseEnv.DB.prepare(
      `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
       VALUES (?1, ?2, 1950000, 30, 50, 'ACTIVE') RETURNING id`,
    )
      .bind(Number(p!.id), `پلن ${label}`)
      .first<{ id: number }>();
    return Number(pl!.id);
  };

  const panelA = await panel('a');
  const panelB = await panel('b');
  return { panelA, panelB, planA: await plan('a', panelA), planB: await plan('b', panelB) };
}

const post = (path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );

async function shelve(planId: number, username: string) {
  return post('/api/v1/admin/stock', {
    planId,
    remoteUsername: username,
    subscriptionUrl: `https://panel.invalid/sub/${username}`,
  });
}

const stockRow = (id: number) =>
  baseEnv.DB.prepare(`SELECT provider_id, status, order_id FROM provisioning_stock WHERE id = ?1`)
    .bind(id)
    .first<{ provider_id: number; status: string; order_id: number | null }>();

/**
 * In dependency order, because the schema refuses any other one:
 * `provisioning_stock.order_id` points at an order and `orders.user_id` at a
 * user, both RESTRICT. Leaving the order behind is what made this file pass
 * once and collide on every run after — `orders.public_id` is UNIQUE.
 */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM provisioning_stock WHERE provider_id IN
       (SELECT id FROM provisioning_providers WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(
    `DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE username LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE username LIKE ?1`).bind(`${PREFIX}%`).run();
}

async function purgeAll(): Promise<void> {
  await purge();
  await baseEnv.DB.prepare(
    `DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
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
  await purgeAll();
  fx = await makeCatalogue();
});

beforeEach(purge);
afterAll(purgeAll);

describe('filling the shelf', () => {
  it('files the config on the plan’s own panel, not one the request names', async () => {
    // `provider_id` is deliberately not a field. A config filed under a plan
    // whose product lives elsewhere is a customer handed an account on a server
    // they did not buy — and nothing downstream would notice.
    const res = await shelve(fx.planA, `${PREFIX}u1`);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };

    expect((await stockRow(id))!.provider_id).toBe(fx.panelA);
    expect((await stockRow(id))!.provider_id).not.toBe(fx.panelB);
  });

  it('lets the unique index answer when the same account is pasted twice', async () => {
    await shelve(fx.planA, `${PREFIX}dup`);
    const again = await shelve(fx.planA, `${PREFIX}dup`);

    expect(again.status).toBe(409);
    const n = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM provisioning_stock WHERE remote_username = ?1`,
    )
      .bind(`${PREFIX}dup`)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('refuses a plan that does not exist rather than shelving an orphan', async () => {
    const res = await shelve(999_999_999, `${PREFIX}orphan`);
    expect(res.status).toBe(404);
  });

  it('refuses a subscription link that is not a link', async () => {
    for (const url of ['vmess://abc', 'javascript:alert(1)', 'u1']) {
      const res = await post('/api/v1/admin/stock', {
        planId: fx.planA,
        remoteUsername: `${PREFIX}bad`,
        subscriptionUrl: url,
      });
      expect(res.status, url).toBe(400);
    }
  });

  it('counts the shelf per plan, not per page', async () => {
    await shelve(fx.planA, `${PREFIX}c1`);
    await shelve(fx.planA, `${PREFIX}c2`);
    await shelve(fx.planB, `${PREFIX}c3`);

    const res = await app.request('/api/v1/admin/stock?pageSize=1', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: unknown[];
      shelves: { planId: number; available: number }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.shelves.find((s) => s.planId === fx.planA)?.available).toBe(2);
    expect(body.shelves.find((s) => s.planId === fx.planB)?.available).toBe(1);
  });
});

describe('taking a config off the shelf', () => {
  it('retires an available one and refuses the second attempt', async () => {
    const { id } = (await (await shelve(fx.planA, `${PREFIX}ret`)).json()) as { id: number };

    expect((await post(`/api/v1/admin/stock/${id}/retire`, {})).status).toBe(200);
    expect((await stockRow(id))!.status).toBe('RETIRED');
    // Guarded inside the UPDATE, so a second press is refused rather than
    // silently re-writing the same row.
    expect((await post(`/api/v1/admin/stock/${id}/retire`, {})).status).toBe(409);
  });

  it('will not retire or delete a config that has been sold', async () => {
    // The row a customer's service points at. Losing it loses the only record
    // of where that account came from.
    const { id } = (await (await shelve(fx.planA, `${PREFIX}sold`)).json()) as { id: number };
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at, last_seen_at)
       VALUES (990000777, ?1, now(), now()) ON CONFLICT (telegram_id) DO UPDATE SET username = ?1
       RETURNING id`,
    )
      .bind(`${PREFIX}buyer`)
      .first<{ id: number }>();
    // A fresh public id every run. `orders.public_id` is UNIQUE and `purge()`
    // cannot drop the row while the shelf still points at it, so a fixed string
    // here would pass once and collide for ever after — green only on a
    // freshly seeded database, which is green by luck.
    const order = await baseEnv.DB.prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, discount_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1950000, 0, 1950000, 'COMPLETED') RETURNING id`,
    )
      .bind(crypto.randomUUID().replace(/-/g, '').slice(0, 10), Number(user!.id), fx.planA)
      .first<{ id: number }>();
    await baseEnv.DB.prepare(
      `UPDATE provisioning_stock SET status = 'USED', order_id = ?2, used_at = now() WHERE id = ?1`,
    )
      .bind(id, Number(order!.id))
      .run();

    expect((await post(`/api/v1/admin/stock/${id}/retire`, {})).status).toBe(409);
    const del = await app.request(`/api/v1/admin/stock/${id}`, { method: 'DELETE' }, envAs(ADMIN));

    expect(del.status).toBe(409);
    expect((await stockRow(id))!.status).toBe('USED');
  });

  it('deletes one that was never sold', async () => {
    const { id } = (await (await shelve(fx.planA, `${PREFIX}del`)).json()) as { id: number };

    const res = await app.request(`/api/v1/admin/stock/${id}`, { method: 'DELETE' }, envAs(ADMIN));

    expect(res.status).toBe(200);
    expect(await stockRow(id)).toBeNull();
  });
});

describe('who sees the accounts', () => {
  it('gives the link to an admin and not to somebody counting stock', async () => {
    await shelve(fx.planA, `${PREFIX}secret`);

    const asAdmin = await (await app.request('/api/v1/admin/stock', {}, envAs(ADMIN))).text();
    const asReviewer = await (await app.request('/api/v1/admin/stock', {}, envAs(REVIEWER))).text();

    // Genuinely in the row both responses were built from.
    expect(asAdmin).toContain(`sub/${PREFIX}secret`);
    // A reviewer counts the shelf; being able to count it is not being handed
    // the accounts on it.
    expect(asReviewer).not.toContain(`sub/${PREFIX}secret`);
    expect(asReviewer).toContain(`${PREFIX}secret`); // the username, which names it
  });

  it('lets nobody but an admin write to the shelf', async () => {
    const res = await shelve(fx.planA, `${PREFIX}nope`);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };

    expect(
      (
        await post(
          '/api/v1/admin/stock',
          {
            planId: fx.planA,
            remoteUsername: `${PREFIX}byreviewer`,
            subscriptionUrl: 'https://panel.invalid/sub/x',
          },
          REVIEWER,
        )
      ).status,
    ).toBe(403);
    expect((await post(`/api/v1/admin/stock/${id}/retire`, {}, REVIEWER)).status).toBe(403);
    expect((await stockRow(id))!.status).toBe('AVAILABLE');
  });
});
