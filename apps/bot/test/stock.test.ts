/**
 * The shelf: what happens to a paid order when the panel will not answer.
 *
 * The rules being pinned here are the ones that cost money if they break — a
 * config sold twice, an order given two configs, the shelf emptied by a blip,
 * a renewal handed somebody else's account. Each is enforced by the database
 * (migration 0010); these tests are what proves the enforcement is reachable.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionPaidOrders } from '../src/provision.js';
import { deliverFromStock, STOCK_GRACE_MS } from '../src/stock.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';

const PROVIDER_CODE = 'sim-stock-panel';

/** Never answers, which is the whole point: every attempt is retryable. */
const deadPanel = (async () =>
  Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

let seq = 0;
function nextIds() {
  seq += 1;
  return { telegramId: 880_000 + seq * 11, publicId: `stk${String(seq).padStart(6, '0')}` };
}

async function paidOrder(
  options: { planCode?: string; kind?: string } = {},
): Promise<{ orderId: number; publicId: string; telegramId: number; planId: number }> {
  const { telegramId, publicId } = nextIds();
  const userId = await makeCustomer(telegramId);
  const plan = await planId(options.planCode ?? 'sim-vip-1m-50');
  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status)
       VALUES (?1, ?2, ?3, ?4, 1, 1950000, 1950000, 'PAID')
       RETURNING id`,
    )
    .bind(publicId, userId, options.kind ?? 'NEW_PURCHASE', plan)
    .first<{ id: number }>();
  return { orderId: row!.id, publicId, telegramId, planId: plan };
}

/** One config on the shelf. Returns its id. */
async function shelve(plan: number, username: string): Promise<number> {
  const provider = await providerId('sim-vip');
  const row = await db
    .prepare(
      `INSERT INTO provisioning_stock
         (plan_id, provider_id, remote_username, remote_ref, subscription_url)
       VALUES (?1, ?2, ?3, '{"kind":"stock"}'::jsonb, ?4)
       RETURNING id`,
    )
    .bind(plan, provider, username, `https://panel.test/sub/${username}`)
    .first<{ id: number }>();
  return row!.id;
}

async function stockRow(id: number) {
  return db
    .prepare(`SELECT status, order_id FROM provisioning_stock WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; order_id: number | null }>();
}

async function orderStatus(id: number): Promise<string> {
  const row = await db
    .prepare(`SELECT status FROM orders WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>();
  return row!.status;
}

async function subsFor(orderId: number) {
  const { results } = await db
    .prepare(
      `SELECT remote_username, subscription_url, note, provider_id, expires_at
         FROM subscriptions WHERE order_id = ?1`,
    )
    .bind(orderId)
    .all<{
      remote_username: string | null;
      subscription_url: string | null;
      note: string | null;
      provider_id: number;
      expires_at: string | null;
    }>();
  return results ?? [];
}

/** A moment late enough that the grace period has passed. */
function afterGrace(): number {
  return Date.now() + STOCK_GRACE_MS + 60_000;
}

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PROVIDER_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://panel.test', secret_ref = ?1, kind = 'pasarguard'`,
    )
    .bind(PROVIDER_CODE)
    .run();
  // Start from an empty shelf: this database is shared and reused.
  await db.prepare(`DELETE FROM provisioning_stock`).run();
});

// Both sides of this leak between tests on a shared database: the sweep takes
// *every* paid order, and the claim takes the lowest available config. Either
// leftover makes a later test pass or fail for the previous test's reason.
beforeEach(async () => {
  await db
    .prepare(
      `UPDATE orders SET status = 'FAILED', failure_reason = 'parked by stock.test'
        WHERE status IN ('PAID', 'PROVISIONING')`,
    )
    .run();
  await db.prepare(`DELETE FROM provisioning_stock`).run();
});

describe('selling from the shelf', () => {
  it('does not touch the shelf while the panel might still come back', async () => {
    const order = await paidOrder();
    const stock = await shelve(order.planId, 'stock-early');

    const notes = await provisionPaidOrders(db, deadPanel, Date.now());

    expect(await orderStatus(order.orderId)).toBe('PAID');
    expect(await stockRow(stock)).toMatchObject({ status: 'AVAILABLE', order_id: null });
    // And nothing is said to the customer — a blip is not news.
    expect(notes.some((n) => n.chatId === order.telegramId)).toBe(false);
  });

  it('finishes the order from the shelf once the panel has been down long enough', async () => {
    const order = await paidOrder();
    const stock = await shelve(order.planId, 'stock-sold');

    const notes = await provisionPaidOrders(db, deadPanel, afterGrace());

    expect(await orderStatus(order.orderId)).toBe('COMPLETED');
    expect(await stockRow(stock)).toMatchObject({ status: 'USED', order_id: order.orderId });

    const subs = await subsFor(order.orderId);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      remote_username: 'stock-sold',
      subscription_url: 'https://panel.test/sub/stock-sold',
      note: `from stock #${stock}`,
    });
    // The link reaches the customer, which is the entire point of the shelf.
    const note = notes.find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain('https://panel.test/sub/stock-sold');
  });

  it('gives one order one config, however many sweeps run', async () => {
    const order = await paidOrder();
    await shelve(order.planId, 'stock-twice-a');
    await shelve(order.planId, 'stock-twice-b');

    await provisionPaidOrders(db, deadPanel, afterGrace());
    await provisionPaidOrders(db, deadPanel, afterGrace());

    expect(await subsFor(order.orderId)).toHaveLength(1);
    const { results } = await db
      .prepare(`SELECT count(*)::int AS n FROM provisioning_stock WHERE order_id = ?1`)
      .bind(order.orderId)
      .all<{ n: number }>();
    expect(results?.[0]?.n).toBe(1);
  });

  it('sells one config to one customer when two orders want it', async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    const stock = await shelve(a.planId, 'stock-contested');

    await provisionPaidOrders(db, deadPanel, afterGrace());

    const statuses = [await orderStatus(a.orderId), await orderStatus(b.orderId)].sort();
    expect(statuses).toEqual(['COMPLETED', 'PAID']);
    const row = await stockRow(stock);
    expect(row?.status).toBe('USED');
    expect([a.orderId, b.orderId]).toContain(row?.order_id);
  });

  it('never hands over a config stocked for a different plan', async () => {
    const order = await paidOrder({ planCode: 'sim-vip-1m-50' });
    const otherPlan = await planId('sim-gold-10');
    const stock = await shelve(otherPlan, 'stock-wrong-plan');

    await provisionPaidOrders(db, deadPanel, afterGrace());

    expect(await orderStatus(order.orderId)).toBe('PAID');
    expect(await stockRow(stock)).toMatchObject({ status: 'AVAILABLE' });
  });

  it('leaves renewals alone — the customer already has an account to extend', async () => {
    const order = await paidOrder({ kind: 'RENEWAL' });
    const stock = await shelve(order.planId, 'stock-renewal');

    await provisionPaidOrders(db, deadPanel, afterGrace());

    // The renewal fails for its own reason (no target service); what matters
    // here is that it did not take a config that belongs to a new purchase.
    expect(await stockRow(stock)).toMatchObject({ status: 'AVAILABLE', order_id: null });

    // Asked directly, too. The sweep happens to route renewals elsewhere before
    // the panel is ever called, so that path alone would leave this guard
    // untested — and it is the one that matters if the routing changes.
    const refused = await deliverFromStock(
      db,
      {
        order_id: order.orderId,
        order_public_id: order.publicId,
        order_kind: 'RENEWAL',
        user_id: 1,
        plan_id: order.planId,
        plan_name: null,
        product_name: null,
        provider_name: null,
        total_irr: 1_950_000,
        volume_gb: 50,
        duration_days: 30,
      },
      afterGrace(),
    );
    expect(refused).toBeNull();
    expect(await stockRow(stock)).toMatchObject({ status: 'AVAILABLE', order_id: null });
  });

  it('refuses to shelve the same panel account twice', async () => {
    const plan = await planId('sim-vip-1m-50');
    await shelve(plan, 'stock-duplicate');
    await expect(shelve(plan, 'stock-duplicate')).rejects.toThrow();
  });
});
