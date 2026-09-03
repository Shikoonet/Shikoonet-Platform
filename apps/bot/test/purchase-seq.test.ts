/**
 * The purchase number in «متن پنل + آیدی عددی + شمارهٔ خرید».
 *
 * This is the first username shape in the product whose suffix is NOT the
 * order's public id, so it is the first one whose uniqueness has to be earned.
 * The number is counted from the orders table rather than stored, and these
 * tests are about the three ways that count can be wrong — each of which ends
 * in the same place: two orders resolving to one name, the adapter finding the
 * account that already exists, reporting SUCCESS, and the customer paying twice
 * for the service they already have.
 *
 * ## Why the table is filled first
 *
 * Rule 9 in CLAUDE.md, applied to a different statement. The sweep reads
 * `LIMIT 20`, and the obvious way to write this count — `ROW_NUMBER() OVER
 * (PARTITION BY user_id ORDER BY id)` — is evaluated AFTER that limit, so it
 * numbers the rows inside the batch rather than the customer's purchases. On a
 * table with three orders in it those two answers are identical and the test is
 * silent about the bug. It only speaks when the customer has orders the sweep
 * did not pick up, which is what `olderPurchases` builds.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';
import { provisionPaidOrders } from '../src/provision.js';


/**
 * A marzban that accepts a create and can be asked what it was sent.
 *
 * Copied from `provision.test.ts` rather than shared. The two suites assert
 * different things about the same call, and a fixture one of them could change
 * under the other is how a test starts passing for the wrong reason.
 */
function fakePanel() {
  const created: string[] = [];
  /** Every create body, so a test can ask what the panel was actually sent. */
  const bodies: Record<string, unknown>[] = [];
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
      bodies.push(body);
      return new Response(
        JSON.stringify({ username: body.username, subscription_url: `/sub/${body.username}` }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { created, bodies, fetchImpl };
}

let seq = 0;

/**
 * A telegram id nothing else in this database has used.
 *
 * Derived from the clock rather than from a constant, and that is not fussiness:
 * an earlier draft used fixed ids, so the orders a previous RUN left behind were
 * counted by the next one. The count then depended on how many times the suite
 * had been run — and the first test, the one written to catch the `ROW_NUMBER`
 * mistake, went green under a deliberately broken implementation because the
 * leftovers happened to add up to the number it expected.
 *
 * A test whose fixture is shared with its own history is not measuring the code.
 */
const RUN = Date.now() % 100_000;
function freshTelegramId(): number {
  seq += 1;
  return 800_000_000 + RUN * 1000 + seq;
}

const PROVIDER_CODE = 'seq-panel-secret';

/**
 * A panel, product and plan that belong to THIS suite.
 *
 * Not `sim-vip`, and that is the second thing this branch learned the hard way.
 * The fixture panel is shared by every bot suite on one Postgres, and vitest
 * runs the files in parallel — so switching a mode on it here renamed the
 * accounts `provision.test.ts` was asserting, WHILE that suite was running. An
 * `afterAll` cannot fix an overlap; only not sharing the row can.
 */
let ownPlan: number | null = null;

async function ownPanelPlan(): Promise<number> {
  if (ownPlan !== null) return ownPlan;
  const provider = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, base_url, secret_ref, config)
       VALUES ('seq-panel', 'پنل شمارهٔ خرید', 'marzban', 'https://panel.test', ?1,
               '{"username_mode":"PANEL_TEXT_SEQ","username_text":"shikoo"}'::jsonb)
       ON CONFLICT (code) DO UPDATE
         SET config = EXCLUDED.config, base_url = EXCLUDED.base_url,
             secret_ref = EXCLUDED.secret_ref, kind = EXCLUDED.kind
       RETURNING id`,
    )
    .bind(PROVIDER_CODE)
    .first<{ id: number }>();
  const category = await db
    .prepare(
      `INSERT INTO product_categories (name, sort_order)
       VALUES ('دستهٔ شمارهٔ خرید', 900)
       ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order
       RETURNING id`,
    )
    .first<{ id: number }>();
  const product = await db
    .prepare(
      `INSERT INTO products (code, name, kind, provider_id, category_id, status)
       VALUES ('seq-product', 'سرویس شمارهٔ خرید', 'vpn', ?1, ?2, 'ACTIVE')
       ON CONFLICT (code) DO UPDATE
         SET provider_id = EXCLUDED.provider_id, category_id = EXCLUDED.category_id
       RETURNING id`,
    )
    .bind(provider!.id, category!.id)
    .first<{ id: number }>();
  const plan = await db
    .prepare(
      `INSERT INTO product_plans (product_id, name, price_irr, volume_gb, duration_days, status)
       SELECT ?1, 'یک‌ماهه', 1000, 20, 30, 'ACTIVE'
        WHERE NOT EXISTS (SELECT 1 FROM product_plans WHERE product_id = ?1)
       RETURNING id`,
    )
    .bind(product!.id)
    .first<{ id: number }>();
  ownPlan =
    plan?.id ??
    (
      await db
        .prepare(`SELECT id FROM product_plans WHERE product_id = ?1 ORDER BY id LIMIT 1`)
        .bind(product!.id)
        .first<{ id: number }>()
    )!.id;
  return ownPlan;
}

/**
 * `count` purchases this customer already made, outside the sweep's reach.
 *
 * COMPLETED **and** stamped a month old, and both halves are load-bearing. The
 * sweep claims PAID orders and also COMPLETED ones the customer was never told
 * about — but only inside `UNTOLD_WINDOW_HOURS`. A first draft of this fixture
 * left `updated_at` at now, so all five orders landed in the same batch, a
 * window function numbered the newest «5» by accident, and the test went green
 * against a deliberately broken implementation.
 *
 * Old rows outside the batch are the only shape that tells the two counts
 * apart. Rule 9, in a different statement: a fixture that cannot produce the
 * bug is silent about it, not proof against it.
 */
async function olderPurchases(userId: number, planIdValue: number, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    seq += 1;
    await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000, 1000, 'COMPLETED')`,
      )
      .bind(`seqold${String(seq).padStart(6, '0')}`, userId, planIdValue)
      .run();
    await db
      .prepare(
        `UPDATE orders SET updated_at = now() - interval '30 days' WHERE public_id = ?1`,
      )
      .bind(`seqold${String(seq).padStart(6, '0')}`)
      .run();
  }
}

async function payFor(userId: number, planIdValue: number): Promise<string> {
  seq += 1;
  const publicId = `seqnew${String(seq).padStart(6, '0')}`;
  await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000, 1000, 'PAID')`,
    )
    .bind(publicId, userId, planIdValue)
    .run();
  return publicId;
}

async function nameSoldUnder(publicId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT s.remote_username FROM subscriptions s
         JOIN orders o ON o.id = s.order_id WHERE o.public_id = ?1`,
    )
    .bind(publicId)
    .first<{ remote_username: string | null }>();
  return row?.remote_username ?? null;
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('the purchase number, counted rather than stored', () => {
  it('counts the customer’s own history, not the sweep’s batch', async () => {
    // The `ROW_NUMBER` trap, made to fire. This customer has four completed
    // purchases the sweep will not read, and one PAID order it will. A window
    // function over the claimed rows would call the new one «1» — the name
    // their FIRST account already has.
    const telegramId = freshTelegramId();
    const userId = await makeCustomer(telegramId);
    const plan = await ownPanelPlan();
    await olderPurchases(userId, plan, 4);

    const publicId = await payFor(userId, plan);
    const panel = fakePanel();
    await provisionPaidOrders(db, panel.fetchImpl);

    expect(await nameSoldUnder(publicId)).toBe(`shikoo_${telegramId}_5`);
  });

  it('gives two purchases of one customer two different names', async () => {
    // The property the whole mode rests on, asserted end to end rather than on
    // the pure function alone.
    const telegramId = freshTelegramId();
    const userId = await makeCustomer(telegramId);
    const plan = await ownPanelPlan();

    const first = await payFor(userId, plan);
    await provisionPaidOrders(db, fakePanel().fetchImpl);
    const second = await payFor(userId, plan);
    await provisionPaidOrders(db, fakePanel().fetchImpl);

    const a = await nameSoldUnder(first);
    const b = await nameSoldUnder(second);
    expect(a).toBe(`shikoo_${telegramId}_1`);
    expect(b).toBe(`shikoo_${telegramId}_2`);
    expect(a).not.toBe(b);
  });

  it('counts accounts migrated from the PHP bot, which carry no order', async () => {
    // Those subscriptions have `order_id IS NULL`, and without them the first
    // purchase made here would be «1» — a name the customer may already own on
    // that panel from the old shop.
    const telegramId = freshTelegramId();
    const userId = await makeCustomer(telegramId);
    const plan = await ownPanelPlan();
    const provider = await db
      .prepare(
        `SELECT pr.provider_id AS id FROM product_plans pl
           JOIN products pr ON pr.id = pl.product_id WHERE pl.id = ?1`,
      )
      .bind(plan)
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, status, purchased_at)
         VALUES (?1, ?2, ?3, 'legacy', 0, ?4, 'ACTIVE', now())`,
      )
      .bind(`legacy-${telegramId}`, userId, provider!.id, `shikoo_${telegramId}_1`)
      .run();

    const publicId = await payFor(userId, plan);
    await provisionPaidOrders(db, fakePanel().fetchImpl);

    // Two, not one: the migrated account is the first.
    expect(await nameSoldUnder(publicId)).toBe(`shikoo_${telegramId}_2`);
  });
});

describe('when two orders resolve to one account anyway', () => {
  it('fails the order and refunds it, instead of retrying for ever', async () => {
    // What migration 0051 buys, and why the branch beside it had to ship at the
    // same time. Without the index the second order silently receives the FIRST
    // one's account — the adapter finds it and reports success. With the index
    // and nothing else, the insert throws, the order stays PROVISIONING,
    // `reclaimStalled` returns it to PAID, and the same name is computed again
    // on the next sweep: a silent double sale traded for a silent infinite loop,
    // with the customer's money held either way.
    const telegramId = freshTelegramId();
    const userId = await makeCustomer(telegramId);
    const plan = await ownPanelPlan();
    const provider = await db
      .prepare(
        `SELECT pr.provider_id AS id FROM product_plans pl
           JOIN products pr ON pr.id = pl.product_id WHERE pl.id = ?1`,
      )
      .bind(plan)
      .first<{ id: number }>();

    // Somebody else already holds the name this order is about to resolve to.
    // Contrived on purpose: the counting rules make it unreachable by ordinary
    // use, and «unreachable» is exactly the claim a guard has to survive being
    // wrong about.
    const squatter = await makeCustomer(freshTelegramId());
    await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, status, purchased_at)
         VALUES (?1, ?2, ?3, 'squatter', 0, ?4, 'ACTIVE', now())`,
      )
      .bind(`squat-${telegramId}`, squatter, provider!.id, `shikoo_${telegramId}_1`)
      .run();

    const publicId = await payFor(userId, plan);
    await provisionPaidOrders(db, fakePanel().fetchImpl);

    const order = await db
      .prepare(`SELECT status, failure_reason FROM orders WHERE public_id = ?1`)
      .bind(publicId)
      .first<{ status: string; failure_reason: string | null }>();
    // FAILED, not stuck in PROVISIONING and not PAID waiting for another go.
    expect(order?.status).toBe('FAILED');
    expect(order?.failure_reason ?? '').toContain('already belongs');
    // And no second subscription was written for it.
    expect(await nameSoldUnder(publicId)).toBeNull();
  });
});
