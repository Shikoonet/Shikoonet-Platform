import { beforeAll, describe, expect, it } from 'vitest';
import { decode, encode, CALLBACK_MAX_BYTES } from '../src/callback.js';
import { handleUpdate } from '../src/handle.js';
import { PANEL_EMPTY, PLAN_GONE } from '../src/menu.js';
import { orderForUser, subscriptionForUser } from '../src/owned.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, giveSubscription, planId, providerId } from './helpers/shop.js';

/**
 * The attack these tests perform is the live one in the current PHP bot:
 * `subscriptionurl_<id>` loads a service by id alone and returns its
 * subscription URL — the VPN credential — to whoever asked. Ids are sequential,
 * so reading every customer's is a counting exercise. BUGS-FOR-ADMIN.md item 8.
 *
 * Here the same attack is run against our own code and must come back empty.
 */

let victim: number;
let attacker: number;
let victimOrderId: number;
let victimSubscriptionId: number;

beforeAll(async () => {
  victim = await makeUser(880_001, 'victim');
  attacker = await makeUser(880_002, 'attacker');
  victimOrderId = await makeOrder(victim, 'sec-order-1');
  victimSubscriptionId = await makeSubscription(victim, 'sec-sub-1');
});

async function makeUser(telegramId: number, name: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at)
       VALUES (?1, ?2, now())
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
    )
    .bind(telegramId, name)
    .first<{ id: number }>();
  if (!row) throw new Error('user fixture failed');
  return row.id;
}

async function makeOrder(userId: number, publicId: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', 1800000, 1800000, 'AWAITING_PAYMENT')
       ON CONFLICT (public_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id`,
    )
    .bind(publicId, userId)
    .first<{ id: number }>();
  if (!row) throw new Error('order fixture failed');
  return row.id;
}

async function makeSubscription(userId: number, publicId: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, 'sec fixture', 1800000, 'ACTIVE', now())
       ON CONFLICT (public_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id`,
    )
    .bind(publicId, userId)
    .first<{ id: number }>();
  if (!row) throw new Error('subscription fixture failed');
  return row.id;
}

describe('a customer cannot reach another customer’s rows', () => {
  it('gives the owner their order', async () => {
    const order = await orderForUser(db, victim, victimOrderId);
    expect(order?.public_id).toBe('sec-order-1');
  });

  it('refuses the same order to anybody else', async () => {
    // The whole attack: a real id, a valid session, the wrong customer.
    expect(await orderForUser(db, attacker, victimOrderId)).toBeNull();
  });

  it('refuses another customer’s subscription — the live PHP bug, here', async () => {
    expect(await subscriptionForUser(db, victim, victimSubscriptionId)).not.toBeNull();
    expect(await subscriptionForUser(db, attacker, victimSubscriptionId)).toBeNull();
  });

  it('answers a missing row and a stolen one identically', async () => {
    // Different answers would tell an attacker which ids exist, which is the
    // enumeration they need before they even start.
    const stolen = await orderForUser(db, attacker, victimOrderId);
    const missing = await orderForUser(db, attacker, 2_000_000_000);
    expect(stolen).toBeNull();
    expect(missing).toBeNull();
  });
});

/**
 * The catalog half of the same rule. A button having been drawn proves nothing:
 * anyone can post `order:<id>` for an id they were never shown, so the order
 * path re-runs the visibility check rather than trusting the journey.
 */
describe('a customer cannot buy what the shop never offered them', () => {
  let buyer: number;
  let buyerTelegramId: number;

  beforeAll(async () => {
    await ensureCatalog();
    buyerTelegramId = 880_010;
    buyer = await makeUser(buyerTelegramId, 'forger');
  });

  it('books nothing for a hidden product', async () => {
    await expectNoOrder(buyer, buyerTelegramId, 990_101, await planId('sim-vip-hidden'));
  });

  it('books nothing on a disabled panel', async () => {
    await expectNoOrder(buyer, buyerTelegramId, 990_102, await planId('sim-off-1m'));
  });

  it('books nothing from a resellers-only plan', async () => {
    await expectNoOrder(buyer, buyerTelegramId, 990_103, await planId('sim-vip-reseller'));
  });

  it('books nothing for a first-purchase offer the customer has used up', async () => {
    await giveSubscription(buyer, 'sec-shop-sub');
    await expectNoOrder(buyer, buyerTelegramId, 990_104, await planId('sim-vip-trial'));
  });

  it('lists nothing for a panel the customer may not open', async () => {
    const outcome = await handleUpdate(
      db,
      pressButton(990_105, buyerTelegramId, `panel:${await providerId('sim-off')}`),
    );
    expect(outcome.replies[0]?.text).toBe(PANEL_EMPTY);
  });
});

async function expectNoOrder(
  userId: number,
  telegramId: number,
  updateId: number,
  targetPlanId: number,
): Promise<void> {
  const before = await countOrders(userId);
  const outcome = await handleUpdate(
    db,
    pressButton(updateId, telegramId, `order:${targetPlanId}`),
  );
  // One answer for every reason, so the reply cannot be used to map the catalog.
  expect(outcome.replies[0]?.text).toBe(PLAN_GONE);
  expect(await countOrders(userId)).toBe(before);
}

async function countOrders(userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function pressButton(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId },
      message: { message_id: 1, chat: { id: telegramId } },
      data,
    },
  };
}

describe('callback data is parsed as untrusted input', () => {
  it('reads the shapes we produce', () => {
    expect(decode('menu')).toEqual({ action: 'menu' });
    expect(decode('panel:12')).toEqual({ action: 'panel', id: 12 });
    expect(decode(encode('order', 99))).toEqual({ action: 'order', id: 99 });
  });

  it('rejects an action nobody implemented', () => {
    expect(decode('admin')).toBeNull();
    expect(decode('deleteUser:1')).toBeNull();
    expect(decode('blockuserfake_5')).toBeNull();
  });

  it('rejects ids that are not plainly a positive integer', () => {
    for (const bad of [
      'panel:-1',
      'panel:0',
      'panel:01', // two spellings of one id
      'panel: 1',
      'panel:1e3',
      'panel:1.0',
      'panel:abc',
      'panel:',
      'panel:1 OR 1=1',
      'panel:99999999999999999999',
    ]) {
      expect(decode(bad), bad).toBeNull();
    }
  });

  it('rejects a payload with extra fields tacked on', () => {
    expect(decode('panel:1:2')).toBeNull();
    expect(decode('panel:1:admin')).toBeNull();
  });

  it('handles absent and empty data', () => {
    expect(decode(undefined)).toBeNull();
    expect(decode('')).toBeNull();
  });

  it('refuses to build a button Telegram would reject', () => {
    expect(() => encode('order', Number.MAX_SAFE_INTEGER)).not.toThrow();
    const longest = encode('order', Number.MAX_SAFE_INTEGER);
    expect(new TextEncoder().encode(longest).length).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });
});
