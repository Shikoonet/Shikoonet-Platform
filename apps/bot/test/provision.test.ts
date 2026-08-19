/**
 * Paid order in, delivered service out — against the real database.
 *
 * The adapter itself is covered in `packages/domain`. What this file is for is
 * everything around it: the state machine on `orders`, the row written to
 * `subscriptions`, and the promise that a customer is never charged twice for
 * one thing or told about a service that does not exist.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { D1DatabaseSession } from '@shikoo/database';
import { provisionPaidOrders } from '../src/provision.js';
import { db, pendingNotifications } from './helpers/env.js';
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

/** A promise plus the handle that settles it, for a test that has to wait. */
function latch(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open };
}
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

    await provisionPaidOrders(db, panel.fetchImpl);

    const notes = await pendingNotifications();
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

  it('still tells the customer when the pretty screen cannot be built', async () => {
    // The delivery screen is read back from the database AFTER the transaction
    // that marked the order COMPLETED, and the caller has no try/catch. So a
    // failure there used to throw past the enqueue: the customer had paid, the
    // panel had delivered, and the only message about it was lost while
    // building a nicer version of it.
    //
    // The fault is injected at the database boundary rather than by stubbing
    // `purchasedScreen`: everything else — the panel call, the transaction, the
    // COMPLETED write, the enqueue — is the real code against the real
    // database, and only the one read the screen needs is made to fail.
    // Renaming the table instead was tried and is not the same test: the sweep's
    // own query joins `provisioning_providers`, so it breaks before an order is
    // ever delivered, which proves nothing about a delivery that already
    // happened.
    const order = await paidOrder();
    const panel = fakePanel();

    const breakScreenRead = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes('SELECT id FROM subscriptions WHERE order_id')) {
            throw new Error('connection reset while reading the delivered subscription');
          }
          return target.prepare(sql);
        };
      },
    });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await provisionPaidOrders(breakScreenRead, panel.fetchImpl);
    } finally {
      errors.mockRestore();
    }

    // Delivered, and said so — with the plain message rather than the screen.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    const note = (await pendingNotifications()).find((n) => n.chatId === order.telegramId);
    expect(note?.text).toContain(`https://panel.test/sub/${order.telegramId}_${order.publicId}`);
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
    await provisionPaidOrders(db, panel.fetchImpl);
    // Delivered once and owed once. A second sweep must not enqueue a second
    // message, and must not remove the first.
    const second = await pendingNotifications();
    expect(second.filter((n) => n.chatId === order.telegramId)).toHaveLength(1);
    expect(await subsFor(order.orderId)).toHaveLength(1);
    expect(panel.created.filter((u) => u.endsWith(order.publicId))).toHaveLength(1);
  });
});

describe('when delivery cannot finish', () => {
  it('leaves the order payable-and-pending and says nothing when the panel is down', async () => {
    const order = await paidOrder();

    await provisionPaidOrders(db, deadPanel);

    const notes = await pendingNotifications();
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
    await provisionPaidOrders(db, fakePanel().fetchImpl);
    const notes = await pendingNotifications();
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    expect(notes.some((n) => n.chatId === order.telegramId)).toBe(true);
  });

  it('stops and asks for a human when trying again cannot help', async () => {
    const order = await paidOrder();

    await provisionPaidOrders(db, brokenRequest);

    const notes = await pendingNotifications();
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

    // Used to assert that `provisionPaidOrders` rejects. It no longer does —
    // the sweep logs this order and moves on — and rejecting was never the
    // property anyway: what keeps the money safe is the rollback, asserted
    // below. Swallowing is the better behaviour and this test now proves why,
    // with a second, healthy order queued behind the broken one. Before the
    // catch, that customer waited for a sweep that died on somebody else's
    // order, every tick, for ever.
    const behind = await paidOrder();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await provisionPaidOrders(db, brokenRequest);
    errors.mockRestore();

    // Rolled back together: still PROVISIONING, so the next sweep retries it.
    // Before the fix this row read FAILED and stayed that way for ever.
    const row = await orderRow(order.orderId);
    expect(row?.status).not.toBe('FAILED');
    // And the order behind it was served rather than stranded.
    expect(await orderRow(behind.orderId)).toMatchObject({ status: 'FAILED' });
    const refunds = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = ?1 AND kind = 'REFUND'`,
      )
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(refunds?.n).toBe(0);
  });

  it('sells one service, not two, when two sweeps interleave inside the write', async () => {
    // H-01. The claim on the order is a real fence and not the whole fence:
    // `reclaimStalled` hands a PROVISIONING order back to PAID once it has been
    // held past the stall window, and a sweep that is SLOW — a panel taking its
    // time — is not a sweep that died. Two sweeps then reach the write for the
    // same order.
    //
    // The window is INSIDE the write, and that matters, because the obvious
    // test does not find it. Holding the first sweep in its panel call and
    // running the second to completion was written first and passed against the
    // OLD code with no index at all: by the time the first opens its
    // transaction, the second's row is committed and its SELECT sees it. What
    // the old code could not survive is both transactions being open at once —
    // each reading "no subscription yet" before either writes. That is
    // read-committed working as designed, and it is exactly why count-then-act
    // is not a guard.
    //
    // So the interleaving is done here, on two real sessions, in the order two
    // sweeps produce it. Postgres is the judge: the second insert has to be
    // refused by the index, not by anything this test or the code believes.
    const order = await paidOrder();
    const bothLooked = latch();
    const firstWrote = latch();

    const insert = (tx: D1DatabaseSession, publicId: string) =>
      tx
        .prepare(
          `INSERT INTO subscriptions
             (public_id, user_id, order_id, plan_id, price_irr, status, purchased_at,
              provider_name_at_sale, plan_name_at_sale)
           VALUES (?1, ?2, ?3, NULL, 1, 'ACTIVE', now(), 'panel', 'plan')`,
        )
        .bind(publicId, order.userId, order.orderId)
        .run();

    const seesNothing = (tx: D1DatabaseSession) =>
      tx
        .prepare(`SELECT id FROM subscriptions WHERE order_id = ?1 LIMIT 1`)
        .bind(order.orderId)
        .first<{ id: number }>();

    let secondFailed: unknown = null;
    const sweepA = db.withSession(async (tx) => {
      expect(await seesNothing(tx)).toBeNull();
      await bothLooked.reached;
      await insert(tx, `raceA${order.orderId}`);
      firstWrote.open();
    });
    const sweepB = db.withSession(async (tx) => {
      // Looked before A wrote — the whole point.
      expect(await seesNothing(tx)).toBeNull();
      bothLooked.open();
      await firstWrote.reached;
      try {
        await insert(tx, `raceB${order.orderId}`);
      } catch (err) {
        secondFailed = err;
        throw err;
      }
    });

    await sweepA;
    await expect(sweepB).rejects.toThrow();

    // Postgres refused it, and named the index doing the refusing.
    expect(String(secondFailed)).toContain('idx_subscriptions_one_per_order');
    // One row for the order, whichever sweep won.
    const subs = await db
      .prepare(`SELECT count(*)::int AS n FROM subscriptions WHERE order_id = ?1`)
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(subs?.n).toBe(1);
  });

  it('does not drag a finished order back out of its terminal state', async () => {
    // The three retryable exits wrote PAID by id alone. An order this sweep no
    // longer owns — reclaimed while it waited, then COMPLETED or FAILED by the
    // sweep that took it — was pulled back to PAID and sold again. Here the
    // panel is down, so the exit taken is the retryable one, and the order is
    // moved to a terminal state underneath it while it waits.
    const order = await paidOrder();
    const inThePanel = latch();
    const letItFinish = latch();

    // Held on THIS order, and only after the panel has answered the login.
    //
    // Latching on any request made the test pass with the guard removed: the
    // sweep paused on an earlier test's leftover order, this one was set
    // COMPLETED before it was ever claimed, and the claim then skipped it, so
    // `release` was never reached and the assertion measured nothing. Failing
    // the login instead never reached a request naming this order at all.
    const heldDeadPanel = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/admin/token')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (`${String(input)}${String(init?.body ?? '')}`.includes(order.publicId)) {
        inThePanel.open();
        await letItFinish.reached;
      }
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sweep = provisionPaidOrders(db, heldDeadPanel);
    await inThePanel.reached;
    // Somebody else finished it while this sweep was waiting on the panel.
    await db
      .prepare(`UPDATE orders SET status = 'COMPLETED', completed_at = now() WHERE id = ?1`)
      .bind(order.orderId)
      .run();
    letItFinish.open();
    await sweep;
    errors.mockRestore();

    // Still COMPLETED. Before the guard this read PAID and the next sweep sold
    // the customer a second service for one payment.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
  });

  it('writes nothing and says nothing when it loses the order at the last step', async () => {
    // The other half of the same race, on the SUCCESS path. The panel answered,
    // the account exists, and while this sweep was waiting for it the order was
    // finished by somebody else. `WHERE status = 'PROVISIONING'` was already on
    // the COMPLETED write; what was missing was anyone reading the answer, so a
    // transition that changed no rows returned exactly like one that changed a
    // row — and the loser went on to write its subscription and tell the
    // customer their service was ready. Two messages, one purchase.
    const order = await paidOrder();
    const inThePanel = latch();
    const letItFinish = latch();
    const fast = fakePanel();

    const heldPanel = (async (input: string | URL | Request, init?: RequestInit) => {
      if (`${String(input)}${String(init?.body ?? '')}`.includes(order.publicId)) {
        inThePanel.open();
        await letItFinish.reached;
      }
      return fast.fetchImpl(input as never, init as never);
    }) as unknown as typeof globalThis.fetch;

    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sweep = provisionPaidOrders(db, heldPanel);
    await inThePanel.reached;
    await db
      .prepare(`UPDATE orders SET status = 'COMPLETED', completed_at = now() WHERE id = ?1`)
      .bind(order.orderId)
      .run();
    letItFinish.open();
    await sweep;
    warns.mockRestore();

    // Rolled back: the loser's subscription row is not there.
    expect(await subsFor(order.orderId)).toHaveLength(0);
    // And it told the customer nothing — the sweep that won does that.
    const notes = (await pendingNotifications()).filter((n) => n.chatId === order.telegramId);
    expect(notes).toHaveLength(0);
    // The sweep survived it rather than dying on somebody else's order.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
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

    await provisionPaidOrders(db, deadPanel);

    const notes = await pendingNotifications();
    // Never reached the network at all — an unknown kind falls to manual.
    expect(await orderRow(order.orderId)).toMatchObject({ status: 'COMPLETED' });
    const sub = (await subsFor(order.orderId))[0]!;
    expect(sub.remote_ref).toMatchObject({ pending: true, kind: 'manual' });
    const note = notes.find((n) => n.chatId === order.telegramId)!;
    expect(note.text).toContain('دستی');
    expect(note.text).not.toContain('http');
  });
});
