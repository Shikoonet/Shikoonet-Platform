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
import { TEXTS } from '@shikoo/contracts';

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
 * A paid RENEWAL against a service that really exists.
 *
 * `renew()` fails an order whose `target_subscription_id` resolves to nothing —
 * terminally, with a refund — so a renewal built without one would never reach
 * the retryable exit this is for.
 */
async function paidRenewal(): Promise<{
  orderId: number;
  publicId: string;
  telegramId: number;
}> {
  const { telegramId, publicId } = nextIds();
  const userId = await makeCustomer(telegramId);
  const plan = await planId('sim-vip-1m-50');
  // The plan's own panel: `beforeAll` turns every provider into a live one, so
  // the renewal resolves against the account's panel exactly as production does.
  const provider = await providerId('sim-vip');
  const sub = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_id, provider_id, plan_name_at_sale,
          provider_name_at_sale, price_irr, remote_username, volume_gb,
          status, purchased_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, 'یک‌ماهه', 'لوکیشن تست', 1950000, ?5, 50,
               'ACTIVE', now(), now() + interval '1 day')
       RETURNING id`,
    )
    .bind(`sub-${publicId}`, userId, plan, provider, `u_${publicId}`)
    .first<{ id: number }>();
  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, target_subscription_id,
                           quantity, unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'RENEWAL', ?3, ?4, 1, 1950000, 1950000, 'PAID')
       RETURNING id`,
    )
    .bind(publicId, userId, plan, sub!.id)
    .first<{ id: number }>();
  return { orderId: row!.id, publicId, telegramId };
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

/**
 * Backdates the first-failure stamp by `ageMs`, against the SAME clock the
 * sweep is given.
 *
 * The point is to stop comparing two clocks. `provision_first_failed_at` is
 * written by Postgres with its own `now()`, and the grace check subtracts it
 * from the mocked `Date.now()` — so a test that lets Postgres set it is
 * asserting against a difference neither side chose.
 */
async function ageFailure(orderId: number, ageMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET provision_first_failed_at = to_timestamp(?2 / 1000.0) WHERE id = ?1`,
    )
    .bind(orderId, Date.now() - ageMs)
    .run();
}

/** The «still working on it» notices for one order, by their own dedupe key. */
async function waitingNotes(
  publicId: string,
): Promise<{ chatId: number; text: string; dedupeKey: string }[]> {
  return (await pendingNotifications()).filter(
    (n) => n.dedupeKey === `provision:${publicId}:waiting`,
  );
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
  // Reset here rather than at the end of the tests that set them. A test whose
  // assertion goes red never reaches its own cleanup, and both of these live in
  // a database this whole suite shares: a leftover delivery note appends itself
  // to somebody else's expected message, and a panel left without credentials
  // fails every purchase after it.
  await db.prepare(`UPDATE product_plans SET attrs = attrs - 'delivery_note'`).run();
  await db.prepare(`UPDATE products SET attrs = attrs - 'delivery_note'`).run();
  await db
    .prepare(
      `UPDATE provisioning_providers SET secret_ref = ?1, base_url = 'https://panel.test'
        WHERE code = ?1`,
    )
    .bind(PROVIDER_CODE)
    .run();
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

  it('tells a waiting customer once, when the shelf could not save them either', async () => {
    /*
     * The worst thing this bot can do to somebody: they paid, they have no
     * config, and they hear nothing at all.
     *
     * Silence is right for a blip — «there was a problem» followed by success a
     * minute later is worse than saying nothing — and the test above pins that.
     * What had no answer was the panel that does not come back. With an EMPTY
     * shelf the retry loop can run for days and the customer cannot tell being
     * queued from being forgotten.
     *
     * Past the shelf's own grace, so it fires only once the shelf has had its
     * chance and could not help. And exactly once: the dedupe key is the order,
     * so a sweep running every twenty-five seconds for a week still says it one
     * time.
     */
    const order = await paidOrder();
    // No shelve() — an empty shelf is the state this exists for.

    // One sweep to stamp `provision_first_failed_at`, then the clock is set
    // from the TEST rather than compared against Postgres's own.
    //
    // The first version of this test asserted the early silence with the stamp
    // left as Postgres wrote it, which is strictly LATER than the mocked clock
    // the sweep is given — so `now - failingSince` was negative and the
    // assertion held for a grace of ten minutes, of one second, or of zero. It
    // pinned nothing. Both edges are driven explicitly now, and the wall-clock
    // budget that construction quietly depended on is gone with it.
    await provisionPaidOrders(db, deadPanel, Date.now());
    await ageFailure(order.orderId, STOCK_GRACE_MS - 60_000);

    // Just inside the grace: still silent, and now for the right reason.
    await provisionPaidOrders(db, deadPanel, Date.now());
    expect(await waitingNotes(order.publicId)).toHaveLength(0);

    // Just past it: told, once, however many sweeps run.
    await ageFailure(order.orderId, STOCK_GRACE_MS + 60_000);
    await provisionPaidOrders(db, deadPanel, Date.now());
    await provisionPaidOrders(db, deadPanel, Date.now());

    // Identified by its own dedupe key, so this cannot pass on somebody else's
    // message to the same chat — a delivery note or a failure carries a
    // different key and would satisfy a `chatId` filter just as well.
    const mine = await waitingNotes(order.publicId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(order.publicId);
    // Against the registry, not against a phrase typed here: this asserts the
    // customer got THIS message and not the delivery one, which also carries
    // the tracking id.
    expect(mine[0]!.text).toContain(TEXTS.SERVICE_STILL_WORKING_TITLE.default);
    // Still retryable — the notice is not a verdict on the order.
    expect(await orderStatus(order.orderId)).toBe('PAID');
  });

  it('tells a waiting RENEWAL customer too, not only a new one', async () => {
    /*
     * One of three retryable exits used to carry this, and `renew()` has the
     * other two — covering RENEWAL, ADD_VOLUME and ADD_TIME. A customer whose
     * renewal could not be applied paid, watched their service expire, and
     * heard nothing at all: the same defect, on the path where they already
     * have something to lose.
     *
     * The notice lives in `release()` now, which is the funnel all three pass
     * through, so this asserts the funnel rather than a third copy of the code.
     */
    const order = await paidRenewal();

    await provisionPaidOrders(db, deadPanel, Date.now());
    await ageFailure(order.orderId, STOCK_GRACE_MS + 60_000);
    await provisionPaidOrders(db, deadPanel, Date.now());

    const mine = await waitingNotes(order.publicId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(TEXTS.SERVICE_STILL_WORKING_TITLE.default);
    expect(await orderStatus(order.orderId)).toBe('PAID');
  });

  it('says nothing to a free trial, because that message talks about money', async () => {
    /*
     * Routing leaves exactly two kinds on the retryable branch: a purchase and
     * a TRIAL. A trial customer paid nothing, and the waiting notice says
     * «پرداخت شما ثبت شده» — so sending it to them states something false
     * about money, which is the one thing this bot must never do.
     *
     * `orders_trial_is_free` requires a zero total and a named panel, so the
     * fixture is the real shape a trial has rather than an approximation.
     */
    const { telegramId, publicId } = nextIds();
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    // The plan's own panel, derived rather than named — `PROVIDER_CODE` in this
    // file is an environment-variable key, not a provider row.
    const panelRow = await db
      .prepare(
        `SELECT p.provider_id FROM products p
           JOIN product_plans pl ON pl.product_id = p.id WHERE pl.id = ?1`,
      )
      .bind(plan)
      .first<{ provider_id: number }>();
    // The panel must actually OFFER a trial, or `deliver()` refuses it before
    // the retryable branch and this test would pass without the fix — which is
    // exactly what a first draft of it did.
    await db
      .prepare(
        `UPDATE provisioning_providers
            SET config = coalesce(config, '{}'::jsonb) || ?2::jsonb WHERE id = ?1`,
      )
      .bind(panelRow!.provider_id, JSON.stringify({ trial_enabled: true, trial_volume_gb: 1, trial_duration_hours: 24 }))
      .run();
    const trial = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, provider_id, quantity,
                             unit_price_irr, total_irr, status)
         VALUES (?1, ?2, 'TRIAL', ?3, ?4, 1, 0, 0, 'PAID')
         RETURNING id`,
      )
      .bind(publicId, userId, plan, panelRow!.provider_id)
      .first<{ id: number }>();

    await provisionPaidOrders(db, deadPanel, afterGrace());
    await provisionPaidOrders(db, deadPanel, afterGrace() + 60_000);

    // By KEY, not «any message to that chat». A trial on a dead panel is also
    // refused by `trialFor` and told so, and asserting on the chat alone would
    // have caught that unrelated message instead of this one.
    const waiting = (await pendingNotifications()).filter(
      (n) => n.dedupeKey === `provision:${publicId}:waiting`,
    );
    expect(waiting).toEqual([]);
    // And the clock column is left alone — nothing on the trial path reads it,
    // so stamping it would be an extra write per sweep for no reader.
    const stamped = await db
      .prepare(`SELECT status, provision_first_failed_at FROM orders WHERE id = ?1`)
      .bind(trial!.id)
      .first<{ status: string; provision_first_failed_at: string | null }>();
    // Still retryable, so it really did reach the branch under test rather than
    // being refused earlier — without this the assertions below pass for the
    // wrong reason, which is what two drafts of this test did.
    expect(stamped?.status).toBe('PAID');
    expect(stamped?.provision_first_failed_at).toBeNull();

    // The trial switch is shared state on a shared database — put it back.
    await db
      .prepare(
        `UPDATE provisioning_providers
            SET config = ((config - 'trial_enabled') - 'trial_volume_gb') - 'trial_duration_hours'
          WHERE id = ?1`,
      )
      .bind(panelRow!.provider_id)
      .run();
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

  });

  it('says none of it to a customer whose order failed', async () => {
    // `tell()` is the funnel for EVERY provisioning message, the refund
    // included. Appending the note to all of them tells somebody who has just
    // been refunded how to sign in to the account they did not get.
    const order = await paidOrder({ planCode: 'sim-vip-1m-50' });
    await db
      .prepare(
        `UPDATE product_plans
            SET attrs = COALESCE(attrs, '{}'::jsonb)
                        || jsonb_build_object('delivery_note', ?2::text)
          WHERE id = ?1`,
      )
      .bind(order.planId, 'برای ورود از مرورگر ناشناس استفاده کن.')
      .run();
    // A panel that refuses without hope of recovery: no credentials configured.
    await db
      .prepare(`UPDATE provisioning_providers SET secret_ref = NULL, base_url = NULL`)
      .run();

    await provisionPaidOrders(db, deadPanel, Date.now());

    expect(await orderStatus(order.orderId)).toBe('FAILED');
    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toBeDefined();
    expect(note?.text).not.toContain('برای ورود از مرورگر ناشناس استفاده کن.');

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
