/**
 * A preparation that failed, tried again — against the real database.
 *
 * ## What this file is defending
 *
 * On 2026-09-02 a staging purchase was approved by hand, the customer was told
 * their order was queued, and the delivery then failed on a panel whose
 * credentials had never been set in that environment. `fail()` wrote FAILED,
 * which nothing sweeps, so the customer had paid and no operator action could
 * serve them. The money was never at risk; the service was simply unreachable.
 *
 * So the promises here are about the second attempt, and every one of them is
 * counted from the tables rather than read off a return value — a function can
 * answer «ok» for the wrong reason and a row cannot. CLAUDE.md rule 6.
 *
 *   - the payment survives the failure and the retry, untouched by both;
 *   - a retry delivers exactly one service, even when two operators click;
 *   - a delivered order cannot be retried into a second one;
 *   - an order whose money went back is terminal, because delivering it now
 *     would be giving the service away;
 *   - and the customer is actually TOLD when the retry works, which is the one
 *     that nearly escaped: the delivery outbox dedupes on one key per order and
 *     the failure message already held it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { retryOrderProvisioning } from '@shikoo/domain';
import { provisionPaidOrders } from '../src/provision.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const PROVIDER_CODE = 'sim-retry-panel';
const ENV_KEY = `PANEL_${PROVIDER_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** A panel that answers, and remembers every account it was asked to make. */
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
    if (method === 'PUT' && url.includes('/api/user/')) {
      return new Response(JSON.stringify({ username: 'x', subscription_url: '/sub/x' }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  /**
   * `provisionPaidOrders` sweeps every paid order in the database, not just the
   * one a test made, so orders left behind by earlier files land in `created`
   * too. Every assertion here is therefore about accounts made for ONE order —
   * the remote username carries its public id, which is what makes that
   * possible.
   */
  const madeFor = (publicId: string) => created.filter((n) => n.includes(publicId));
  return { created, madeFor, fetchImpl };
}

/**
 * A token that is different every run, because `audit_logs` cannot be cleaned.
 *
 * A trigger in Postgres refuses DELETE on that table — it is append-only, and
 * that is a guarantee this repository keeps rather than a detail. So the rows
 * this file writes survive it, and counting «how many retries did this order
 * have» only means anything if the order number was never used before.
 */
const RUN = Date.now().toString(36).slice(-5);

let seq = 0;
function nextIds() {
  seq += 1;
  return { telegramId: 880_000 + seq * 13, publicId: `rty${RUN}${seq}` };
}

/** Whether the panel behind this plan has credentials the bot can find. */
async function setCredentials(plan: number, present: boolean): Promise<void> {
  await db
    .prepare(
      `UPDATE provisioning_providers SET secret_ref = ?2
        WHERE id = (SELECT pr.provider_id FROM product_plans pl
                      JOIN products pr ON pr.id = pl.product_id WHERE pl.id = ?1)`,
    )
    .bind(plan, present ? PROVIDER_CODE : null)
    .run();
}

/** A paid order sitting exactly where the settlement sweep leaves one. */
async function paidOrder(
  opts: { credentials?: boolean; method?: 'CARD_TO_CARD' | 'WALLET' } = {},
): Promise<{ orderId: number; publicId: string; telegramId: number; userId: number; paymentId: number }> {
  const { telegramId, publicId } = nextIds();
  const userId = await makeCustomer(telegramId);
  const plan = await planId('sim-vip-1m-50');
  await setCredentials(plan, opts.credentials ?? false);

  const order = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1950000, 1950000, 'PAID')
       RETURNING id`,
    )
    .bind(publicId, userId, plan)
    .first<{ id: number }>();

  // The payment the operator approved. Everything below asserts this row is
  // never touched again — not by the failure, and not by the retry.
  const payment = await db
    .prepare(
      `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
       VALUES (?1, ?2, ?3, 1950000, ?4, 'PAID', now())
       RETURNING id`,
    )
    .bind(`pay${publicId}`, userId, order!.id, opts.method ?? 'CARD_TO_CARD')
    .first<{ id: number }>();

  // A wallet purchase has a ledger row to refund; a card payment does not.
  if ((opts.method ?? 'CARD_TO_CARD') === 'WALLET') {
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, actor, idempotency_key)
         VALUES (?1, -1950000, 'PURCHASE', ?2, 'SYSTEM', ?3)`,
      )
      .bind(userId, order!.id, `order:${order!.id}:purchase`)
      .run();
  }

  return { orderId: order!.id, publicId, telegramId, userId, paymentId: payment!.id };
}

async function orderRow(id: number) {
  return db
    .prepare(`SELECT status, failure_reason FROM orders WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; failure_reason: string | null }>();
}

async function paymentRow(id: number) {
  return db
    .prepare(`SELECT status, amount_irr, order_id FROM payments WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; amount_irr: number; order_id: number }>();
}

async function countSubs(orderId: number): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE order_id = ?1`)
    .bind(orderId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function countRetryAudits(publicId: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE action = 'order.provisioning_retried' AND entity_id = ?1`,
    )
    .bind(publicId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Every notice the customer has waiting, oldest first. */
async function noticesFor(telegramId: number): Promise<{ text: string; dedupeKey: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT body, dedupe_key FROM bot_notifications WHERE chat_id = ?1 ORDER BY id`,
    )
    .bind(telegramId)
    .all<{ body: string; dedupe_key: string }>();
  return (results ?? []).map((r) => ({ text: r.body, dedupeKey: r.dedupe_key }));
}

const ACTOR = { actorEmail: 'sam@example.com', actorRole: 'ADMIN' };

beforeAll(async () => {
  await ensureCatalog();
  process.env[ENV_KEY] = 'admin:secret';
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://panel.test', kind = 'pasarguard', secret_ref = NULL`,
    )
    .run();
});

describe('a preparation that failed for want of configuration', () => {
  it('keeps the payment, allocates nothing, and says so safely', async () => {
    const { orderId, publicId, telegramId, paymentId } = await paidOrder();
    const panel = fakePanel();

    await provisionPaidOrders(db, panel.fetchImpl);

    const order = await orderRow(orderId);
    expect(order?.status).toBe('FAILED');
    expect(order?.failure_reason).toContain('no credentials found');
    // Nothing was made: no account on the panel, no entitlement in the shop.
    expect(panel.madeFor(publicId)).toEqual([]);
    expect(await countSubs(orderId)).toBe(0);

    // The payment is exactly as the operator left it.
    const payment = await paymentRow(paymentId);
    expect(payment?.status).toBe('PAID');

    // What the customer was told carries a reference and nothing else. No
    // panel name, no secret, no exception.
    const [notice] = await noticesFor(telegramId);
    expect(notice?.text).toContain(publicId);
    expect(notice?.text).not.toContain('secret');
    expect(notice?.text).not.toContain('admin:secret');
    expect(notice?.text).not.toContain('no credentials');
  });

  it('is delivered by a retry, once, and the customer is actually told', async () => {
    const { orderId, publicId, telegramId, paymentId } = await paidOrder();
    const panel = fakePanel();
    await provisionPaidOrders(db, panel.fetchImpl);
    expect((await orderRow(orderId))?.status).toBe('FAILED');

    // The operator fixes the configuration and asks for another attempt.
    await setCredentials(await planId('sim-vip-1m-50'), true);
    const out = await retryOrderProvisioning(db, { orderPublicId: publicId, ...ACTOR });
    expect(out.outcome).toBe('QUEUED');
    expect((await orderRow(orderId))?.status).toBe('PAID');
    expect((await orderRow(orderId))?.failure_reason).toBeNull();

    await provisionPaidOrders(db, panel.fetchImpl);

    expect((await orderRow(orderId))?.status).toBe('COMPLETED');
    expect(await countSubs(orderId)).toBe(1);
    expect(panel.madeFor(publicId)).toHaveLength(1);

    // The one that nearly escaped. The failure notice already held
    // «provision:<id>», so without stepping it aside the success message would
    // have been swallowed by ON CONFLICT DO NOTHING and this customer would
    // have been served in silence.
    const notices = await noticesFor(telegramId);
    expect(notices).toHaveLength(2);
    expect(notices[1]?.dedupeKey).toBe(`provision:${publicId}`);
    expect(notices[1]?.text).toContain('سرویس شما آماده است');
    // The superseded notice keeps its row and its history.
    expect(notices[0]?.dedupeKey).toMatch(new RegExp(`^provision:${publicId}:attempt:\\d+$`));

    // And the payment was never approved a second time.
    expect((await paymentRow(paymentId))?.status).toBe('PAID');
    const payments = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM payments WHERE order_id = ?1`)
      .bind(orderId)
      .first<{ n: number }>();
    expect(payments?.n).toBe(1);
  });

  it('gives one entitlement when two operators retry at once', async () => {
    const { orderId, publicId } = await paidOrder();
    const panel = fakePanel();
    await provisionPaidOrders(db, panel.fetchImpl);
    await setCredentials(await planId('sim-vip-1m-50'), true);

    const [a, b] = await Promise.all([
      retryOrderProvisioning(db, { orderPublicId: publicId, ...ACTOR }),
      retryOrderProvisioning(db, { orderPublicId: publicId, ...ACTOR }),
    ]);

    // One requeued it; the other was told the truth about what the first did.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['IN_PROGRESS', 'QUEUED']);
    // Counted from the table, because a return value can be wrong twice.
    expect(await countRetryAudits(publicId)).toBe(1);

    await provisionPaidOrders(db, panel.fetchImpl);
    expect(await countSubs(orderId)).toBe(1);
    expect(panel.madeFor(publicId)).toHaveLength(1);
  });

  it('refuses to run twice over a delivered order', async () => {
    const { orderId, publicId } = await paidOrder({ credentials: true });
    const panel = fakePanel();
    await provisionPaidOrders(db, panel.fetchImpl);
    expect((await orderRow(orderId))?.status).toBe('COMPLETED');

    const out = await retryOrderProvisioning(db, { orderPublicId: publicId, ...ACTOR });

    expect(out.outcome).toBe('ALREADY_DELIVERED');
    expect((await orderRow(orderId))?.status).toBe('COMPLETED');
    expect(await countSubs(orderId)).toBe(1);
    expect(panel.madeFor(publicId)).toHaveLength(1);
    // A no-op writes no audit row: nothing happened to record.
    expect(await countRetryAudits(publicId)).toBe(0);

    // A second sweep must not build a second account either.
    await provisionPaidOrders(db, panel.fetchImpl);
    expect(await countSubs(orderId)).toBe(1);
  });

  it('is terminal once the money has gone back', async () => {
    const { orderId, publicId, userId } = await paidOrder({ method: 'WALLET' });
    const panel = fakePanel();
    await provisionPaidOrders(db, panel.fetchImpl);
    expect((await orderRow(orderId))?.status).toBe('FAILED');

    // `fail()` returned the wallet credit, so the customer has been settled with.
    const refund = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM wallet_entries
          WHERE order_id = ?1 AND kind = 'REFUND' AND user_id = ?2`,
      )
      .bind(orderId, userId)
      .first<{ n: number }>();
    expect(refund?.n).toBe(1);

    await setCredentials(await planId('sim-vip-1m-50'), true);
    const out = await retryOrderProvisioning(db, { orderPublicId: publicId, ...ACTOR });

    // Delivering now would be giving the service away.
    expect(out.outcome).toBe('REFUNDED');
    expect((await orderRow(orderId))?.status).toBe('FAILED');
    expect(await countSubs(orderId)).toBe(0);
    expect(await countRetryAudits(publicId)).toBe(0);
  });

  it('answers for an order number that does not exist', async () => {
    const out = await retryOrderProvisioning(db, { orderPublicId: 'nosuchorder', ...ACTOR });
    expect(out.outcome).toBe('NOT_FOUND');
  });
});
