/**
 * The shelf: what happens to a paid order when the panel will not answer.
 *
 * The rules being pinned here are the ones that cost money if they break — a
 * config sold twice, an order given two configs, the shelf emptied by a blip,
 * a renewal handed somebody else's account. Each is enforced by the database
 * (migration 0010); these tests are what proves the enforcement is reachable.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionPaidOrders } from '../src/provision.js';
import { deliverFromStock, STOCK_GRACE_MS } from '../src/stock.js';
import { db, pendingNotifications } from './helpers/env.js';
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

/**
 * One row on the shelf. A config link by default; pass `secret` for an account
 * (0057), which shelves with no link at all — the pair IS the product.
 */
async function shelve(
  plan: number,
  username: string,
  options: { secret?: string; providerCode?: string } = {},
): Promise<number> {
  const provider = await providerId(options.providerCode ?? 'sim-vip');
  const row = await db
    .prepare(
      `INSERT INTO provisioning_stock
         (plan_id, provider_id, remote_username, remote_ref, subscription_url, secret)
       VALUES (?1, ?2, ?3, '{"kind":"stock"}'::jsonb, ?4, ?5)
       RETURNING id`,
    )
    .bind(
      plan,
      provider,
      username,
      options.secret === undefined ? `https://panel.test/sub/${username}` : null,
      options.secret ?? null,
    )
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

/**
 * The clock these tests run on, pinned so two reads inside one test cannot
 * drift apart.
 *
 * Captured from the real clock rather than written down. A hardcoded instant
 * would be a time bomb of the other kind here: `provision_first_failed_at` is
 * stamped by Postgres with its OWN `now()`, and the grace check subtracts that
 * from this. Pin these two hours apart and every grace assertion in this file
 * flips for a reason that has nothing to do with the code.
 */
const NOW_MS = Date.now();

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
  // The blanket update above turns every provider into a panel; the account
  // shop must stay adapterless, or the stock-first tests below would be
  // testing the outage path instead.
  await db
    .prepare(`UPDATE provisioning_providers SET kind = 'manual' WHERE code = 'sim-shop'`)
    .run();
  // Start from an empty shelf: this database is shared and reused.
  await db.prepare(`DELETE FROM provisioning_stock`).run();
});

// Both sides of this leak between tests on a shared database: the sweep takes
// *every* paid order, and the claim takes the lowest available config. Either
// leftover makes a later test pass or fail for the previous test's reason.
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await db
    .prepare(
      `UPDATE orders SET status = 'FAILED', failure_reason = 'parked by stock.test'
        WHERE status IN ('PAID', 'PROVISIONING')`,
    )
    .run();
  await db.prepare(`DELETE FROM provisioning_stock`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selling from the shelf', () => {
  it('does not touch the shelf while the panel might still come back', async () => {
    const order = await paidOrder();
    const stock = await shelve(order.planId, 'stock-early');

    await provisionPaidOrders(db, deadPanel, Date.now());

    const notes = await pendingNotifications();
    expect(await orderStatus(order.orderId)).toBe('PAID');
    expect(await stockRow(stock)).toMatchObject({ status: 'AVAILABLE', order_id: null });
    // And nothing is said to the customer — a blip is not news.
    expect(notes.some((n) => n.chatId === order.telegramId)).toBe(false);
  });

  it('finishes the order from the shelf once the panel has been down long enough', async () => {
    const order = await paidOrder();
    const stock = await shelve(order.planId, 'stock-sold');

    await provisionPaidOrders(db, deadPanel, afterGrace());

    const notes = await pendingNotifications();
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

/**
 * The shelf's second job (0057): for a product with no automated adapter — an
 * AI account, Spotify, anything sold as a username and password — the shelf is
 * not the outage fallback, it is the delivery itself. No grace: nothing is
 * failing, there is no panel that might come back.
 */
describe('selling accounts from the shelf', () => {
  it('hands a shelved account over on the first sweep, password and all', async () => {
    const order = await paidOrder({ planCode: 'sim-shop-ai' });
    const stock = await shelve(order.planId, 'stock-acct@mail.test', {
      secret: 'stock-acct-pw-1',
      providerCode: 'sim-shop',
    });

    await provisionPaidOrders(db, deadPanel, Date.now());

    expect(await orderStatus(order.orderId)).toBe('COMPLETED');
    expect(await stockRow(stock)).toMatchObject({ status: 'USED', order_id: order.orderId });

    const subs = await subsFor(order.orderId);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      remote_username: 'stock-acct@mail.test',
      subscription_url: null,
      note: `from stock #${stock}`,
    });
    // The password rides in remote_ref so support can find it months later.
    const ref = await db
      .prepare(`SELECT remote_ref->>'secret' AS secret FROM subscriptions WHERE order_id = ?1`)
      .bind(order.orderId)
      .first<{ secret: string | null }>();
    expect(ref?.secret).toBe('stock-acct-pw-1');

    // Both halves of the credential reach the customer — a username without
    // its password is not a delivery.
    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain('stock-acct@mail.test');
    expect(note?.text).toContain('stock-acct-pw-1');

    // Nothing failed, so nothing was stamped as failing.
    const failed = await db
      .prepare(`SELECT provision_first_failed_at FROM orders WHERE id = ?1`)
      .bind(order.orderId)
      .first<{ provision_first_failed_at: string | null }>();
    expect(failed?.provision_first_failed_at).toBeNull();
  });

  it('falls back to the manual path when the shelf is empty, not a retry loop', async () => {
    const order = await paidOrder({ planCode: 'sim-shop-ai' });

    await provisionPaidOrders(db, deadPanel, Date.now());

    // Exactly what an adapterless product did before the shelf could hold
    // accounts: sold, completed, and a person finishes it.
    expect(await orderStatus(order.orderId)).toBe('COMPLETED');
    const subs = await subsFor(order.orderId);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.subscription_url).toBeNull();
    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain(order.publicId);
  });

  it('still carries the password when the first message was lost', async () => {
    // The delivery commits, then the message does not reach the customer — the
    // process dies, the enqueue fails. The sweep's second branch rebuilds the
    // sentence from the database, and that path draws the service CARD, which
    // is built from the subscription row and never renders `remote_ref`. So the
    // recovery used to hand back a username, an expiry, and no password: an
    // account somebody paid for and cannot sign into.
    const order = await paidOrder({ planCode: 'sim-shop-ai' });
    await shelve(order.planId, 'stock-acct-lost@mail.test', {
      secret: 'stock-acct-pw-lost',
      providerCode: 'sim-shop',
    });

    await provisionPaidOrders(db, deadPanel, Date.now());
    const gone = await db
      .prepare(`DELETE FROM bot_notifications WHERE dedupe_key = ?1`)
      .bind(`provision:${order.publicId}`)
      .run();
    // The fixture has to actually remove something, or this proves nothing
    // about a message that was never there.
    expect(gone.meta.changes).toBe(1);

    await provisionPaidOrders(db, deadPanel, Date.now());

    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.dedupeKey).toBe(`provision:${order.publicId}`);
    expect(note?.text).toContain('stock-acct-lost@mail.test');
    expect(note?.text).toContain('stock-acct-pw-lost');
  });

  it('sends the shop’s own words under the account', async () => {
    // Setup steps for a ChatGPT account, where to point an OpenVPN client, a
    // support handle — set once on the service or the plan, appended to every
    // delivery. It rides in `attrs`, which is why there is no column for it.
    const order = await paidOrder({ planCode: 'sim-shop-ai' });
    await shelve(order.planId, 'stock-acct-noted@mail.test', {
      secret: 'stock-acct-pw-noted',
      providerCode: 'sim-shop',
    });
    await db
      .prepare(
        `UPDATE product_plans
            SET attrs = COALESCE(attrs, '{}'::jsonb)
                        || jsonb_build_object('delivery_note', ?2::text)
          WHERE id = ?1`,
      )
      .bind(order.planId, 'برای ورود از مرورگر ناشناس استفاده کن.')
      .run();

    await provisionPaidOrders(db, deadPanel, Date.now());

    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain('stock-acct-pw-noted');
    expect(note?.text).toContain('برای ورود از مرورگر ناشناس استفاده کن.');
    // After a blank line, never on the password's own line — anything there
    // becomes part of what the customer copies.
    expect(note?.text).toMatch(/\n\nبرای ورود/);

    await db
      .prepare(`UPDATE product_plans SET attrs = attrs - 'delivery_note' WHERE id = ?1`)
      .bind(order.planId)
      .run();
  });

  it('lets a service’s words stand in for every plan under it', async () => {
    const order = await paidOrder({ planCode: 'sim-shop-ai' });
    await shelve(order.planId, 'stock-acct-svcnote@mail.test', {
      secret: 'stock-acct-pw-svcnote',
      providerCode: 'sim-shop',
    });
    await db
      .prepare(
        `UPDATE products
            SET attrs = COALESCE(attrs, '{}'::jsonb)
                        || jsonb_build_object('delivery_note', ?2::text)
          WHERE code = ?1`,
      )
      .bind('sim-shop-ai', 'پشتیبانی: @shikoo_support')
      .run();

    await provisionPaidOrders(db, deadPanel, Date.now());

    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain('پشتیبانی: @shikoo_support');

    await db
      .prepare(`UPDATE products SET attrs = attrs - 'delivery_note' WHERE code = ?1`)
      .bind('sim-shop-ai')
      .run();
  });

  it('keeps a config link off the account message path', async () => {
    // A shelved row for an adapterless product can still carry a link — then it
    // is delivered as a link, exactly like the outage path would.
    const order = await paidOrder({ planCode: 'sim-shop-ai' });
    await shelve(order.planId, 'stock-acct-link', { providerCode: 'sim-shop' });

    await provisionPaidOrders(db, deadPanel, Date.now());

    expect(await orderStatus(order.orderId)).toBe('COMPLETED');
    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain('https://panel.test/sub/stock-acct-link');
  });
});
