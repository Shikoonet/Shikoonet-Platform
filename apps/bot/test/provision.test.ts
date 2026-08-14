/**
 * Paid order in, delivered service out — against the real database.
 *
 * The adapter itself is covered in `packages/domain`. What this file is for is
 * everything around it: the state machine on `orders`, the row written to
 * `subscriptions`, and the promise that a customer is never charged twice for
 * one thing or told about a service that does not exist.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { provisionPaidOrders } from '../src/provision.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const PROVIDER_CODE = 'sim-provision-panel';

/** A panel that answers, and remembers what it was asked to make. */
function fakePanel() {
  const created: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/api/user/')) {
      const name = decodeURIComponent(url.split('/api/user/')[1]!);
      return created.includes(name)
        ? new Response(JSON.stringify({ username: name, subscription_url: `/sub/${name}` }), {
            status: 200,
          })
        : new Response('{}', { status: 404 });
    }
    if (method === 'POST' && url.endsWith('/api/user')) {
      const body = JSON.parse(String(init?.body)) as { username: string };
      created.push(body.username);
      return new Response(
        JSON.stringify({ username: body.username, subscription_url: `/sub/${body.username}` }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { created, fetchImpl };
}

const deadPanel = (async () =>
  Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

const brokenRequest = (async (input: string | URL | Request) =>
  String(input).endsWith('/api/admin/token')
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response('{}', { status: 422 })) as unknown as typeof globalThis.fetch;

let seq = 0;
function nextIds() {
  seq += 1;
  return { telegramId: 770_000 + seq * 7, publicId: `prov${String(seq).padStart(6, '0')}` };
}

/** A paid order sitting exactly where the settlement sweep leaves one. */
async function paidOrder(options: { kind?: string; planCode?: string } = {}): Promise<{
  orderId: number;
  publicId: string;
  telegramId: number;
  userId: number;
}> {
  const { telegramId, publicId } = nextIds();
  const userId = await makeCustomer(telegramId);
  const plan = await planId(options.planCode ?? 'sim-vip-1m-50');

  if (options.kind) {
    await db
      .prepare(
        `UPDATE provisioning_providers SET kind = ?2, base_url = 'https://panel.test', secret_ref = ?3
          WHERE id = (SELECT pr.provider_id FROM product_plans pl
                        JOIN products pr ON pr.id = pl.product_id WHERE pl.id = ?1)`,
      )
      .bind(plan, options.kind, PROVIDER_CODE)
      .run();
  }

  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1950000, 1950000, 'PAID')
       RETURNING id`,
    )
    .bind(publicId, userId, plan)
    .first<{ id: number }>();
  return { orderId: row!.id, publicId, telegramId, userId };
}

async function orderRow(id: number) {
  return db
    .prepare(`SELECT status, failure_reason, completed_at FROM orders WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; failure_reason: string | null; completed_at: string | null }>();
}

async function subsFor(orderId: number) {
  const { results } = await db
    .prepare(
      `SELECT public_id, remote_username, status, price_irr, volume_gb, duration_days,
              remote_ref, provider_name_at_sale, plan_name_at_sale, expires_at
         FROM subscriptions WHERE order_id = ?1`,
    )
    .bind(orderId)
    .all<{
      public_id: string;
      remote_username: string | null;
      status: string;
      price_irr: number;
      volume_gb: string | null;
      duration_days: number | null;
      remote_ref: Record<string, unknown>;
      provider_name_at_sale: string | null;
      plan_name_at_sale: string;
      expires_at: string | null;
    }>();
  return results ?? [];
}

beforeAll(async () => {
  await ensureCatalog();
  // Every fixture panel points at the fake, and the credentials come from the
  // environment exactly as they do in production — never from the database.
  process.env[`PANEL_${PROVIDER_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://panel.test', secret_ref = ?1, kind = 'pasarguard'`,
    )
    .bind(PROVIDER_CODE)
    .run();
});

describe('delivering a paid order', () => {
  it('creates the account, records the subscription, and completes the order', async () => {
    const order = await paidOrder();
    const panel = fakePanel();

    const notes = await provisionPaidOrders(db, panel.fetchImpl);

    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    const subs = await subsFor(order.orderId);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      public_id: order.publicId,
      remote_username: `${order.telegramId}_${order.publicId}`,
      status: 'ACTIVE',
      price_irr: 1_950_000,
    });
    // What the customer is sent must be the link that actually exists.
    const note = notes.find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain(`https://panel.test/sub/${order.telegramId}_${order.publicId}`);
    expect(panel.created).toContain(`${order.telegramId}_${order.publicId}`);
  });

  it('keeps what was sold readable even after the catalogue moves on', async () => {
    const order = await paidOrder();

    await provisionPaidOrders(db, fakePanel().fetchImpl);

    const sub = (await subsFor(order.orderId))[0]!;
    expect(sub.plan_name_at_sale).toBeTruthy();
    expect(sub.provider_name_at_sale).toBeTruthy();
    expect(sub.remote_ref).toMatchObject({ panel: expect.any(String) });
  });

  it('does nothing the second time', async () => {
    const order = await paidOrder();
    const panel = fakePanel();

    await provisionPaidOrders(db, panel.fetchImpl);
    const second = await provisionPaidOrders(db, panel.fetchImpl);

    expect(second.some((n) => n.chatId === order.telegramId)).toBe(false);
    expect(await subsFor(order.orderId)).toHaveLength(1);
    expect(panel.created.filter((u) => u.endsWith(order.publicId))).toHaveLength(1);
  });
});

describe('when delivery cannot finish', () => {
  it('leaves the order payable-and-pending and says nothing when the panel is down', async () => {
    const order = await paidOrder();

    const notes = await provisionPaidOrders(db, deadPanel);

    // Back to PAID so the next sweep tries again.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'PAID' });
    expect(await subsFor(order.orderId)).toHaveLength(0);
    // The customer is told nothing. A panel briefly down is not news, and
    // apologising a minute before succeeding is worse than silence.
    expect(notes.some((n) => n.chatId === order.telegramId)).toBe(false);
  });

  it('recovers on the next sweep once the panel is back', async () => {
    const order = await paidOrder();

    await provisionPaidOrders(db, deadPanel);
    const notes = await provisionPaidOrders(db, fakePanel().fetchImpl);

    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    expect(notes.some((n) => n.chatId === order.telegramId)).toBe(true);
  });

  it('stops and asks for a human when trying again cannot help', async () => {
    const order = await paidOrder();

    const notes = await provisionPaidOrders(db, brokenRequest);

    const row = await orderRow(order.orderId);
    expect(row?.status).toBe('FAILED');
    // The reason has to be readable by whoever picks this up.
    expect(row?.failure_reason).toContain('422');
    expect(await subsFor(order.orderId)).toHaveLength(0);
    // And the customer is told their money is safe, rather than left silent.
    const note = notes.find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain(order.publicId);
  });

  it('does not end an order it cannot refund', async () => {
    // Ending the order and returning the credit used to be two autocommitted
    // statements. Anything that stopped the process between them — a deploy, an
    // OOM kill — left the order FAILED with the money gone, and nothing sweeps
    // a FAILED order: `reclaimStalled` only picks up PROVISIONING. The customer
    // was not even told, because the message is built from what `fail` returns.
    //
    // The failure here is Postgres's own, not a mock: the wallet balance is a
    // bigint, and a refund large enough to overflow it makes the trigger throw
    // inside the refund — exactly where a crash would have landed.
    const order = await paidOrder();
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
         VALUES (?1, 1, 'TOPUP', ?2)`,
      )
      .bind(order.userId, `m1:${order.orderId}:seed`)
      .run();
    await db
      .prepare(
        `INSERT INTO payments (public_id, order_id, user_id, amount_irr, method, status, created_at)
         VALUES (?1, ?2, ?3, 9223372036854775807, 'WALLET', 'PAID', now())`,
      )
      .bind(`m1${order.publicId}`, order.orderId, order.userId)
      .run();

    await expect(provisionPaidOrders(db, brokenRequest)).rejects.toThrow();

    // Rolled back together: still PROVISIONING, so the next sweep retries it.
    // Before the fix this row read FAILED and stayed that way for ever.
    const row = await orderRow(order.orderId);
    expect(row?.status).not.toBe('FAILED');
    const refunds = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = ?1 AND kind = 'REFUND'`,
      )
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(refunds?.n).toBe(0);
  });

  it('takes back an order left mid-flight by a sweep that died', async () => {
    const order = await paidOrder();
    await db
      .prepare(
        `UPDATE orders SET status = 'PROVISIONING', updated_at = now() - interval '10 minutes'
          WHERE id = ?1`,
      )
      .bind(order.orderId)
      .run();

    await provisionPaidOrders(db, fakePanel().fetchImpl);

    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    expect(await subsFor(order.orderId)).toHaveLength(1);
  });

  it('does not touch an order another sweep is still working on', async () => {
    const order = await paidOrder();
    await db
      .prepare(`UPDATE orders SET status = 'PROVISIONING', updated_at = now() WHERE id = ?1`)
      .bind(order.orderId)
      .run();

    await provisionPaidOrders(db, fakePanel().fetchImpl);

    expect(await orderRow(order.orderId)).toMatchObject({ status: 'PROVISIONING' });
    expect(await subsFor(order.orderId)).toHaveLength(0);
  });
});

describe('a product with no automation', () => {
  it('is completed and queued for a person, not failed, and promises no link', async () => {
    const order = await paidOrder({ kind: 'spotify' });

    const notes = await provisionPaidOrders(db, deadPanel);

    // Never reached the network at all — an unknown kind falls to manual.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    const sub = (await subsFor(order.orderId))[0]!;
    expect(sub.remote_ref).toMatchObject({ pending: true, kind: 'manual' });
    const note = notes.find((n) => n.chatId === order.telegramId)!;
    expect(note.text).toContain('دستی');
    expect(note.text).not.toContain('http');
  });
});
