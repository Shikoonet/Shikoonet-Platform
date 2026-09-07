/**
 * The one message the bot sends to somebody who is not a customer.
 *
 * Two things can go wrong here and neither throws: nudging the same person
 * twice, and nudging somebody who did buy. Both are the shop looking careless
 * to a person it was trying to win over, so both are asserted from the side
 * where the sweep must refuse.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nudgeNeverBought } from '../src/nudge.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings } from '../src/settings.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 6, 12, 0, 0);
const DAY = 86_400_000;

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 780_000 + seq * 17;
}

/** A person who pressed «شروع» this many days ago and did nothing else. */
async function starter(daysAgo: number, options: { blocked?: boolean; muted?: boolean } = {}) {
  const telegramId = nextTelegramId();
  const userId = await makeCustomer(telegramId);
  await db
    .prepare(
      `UPDATE users
          SET registered_at = ?2,
              status = ?3,
              notify_enabled = ?4
        WHERE id = ?1`,
    )
    .bind(
      userId,
      new Date(NOW_MS - daysAgo * DAY).toISOString(),
      options.blocked === true ? 'BLOCKED' : 'ACTIVE',
      options.muted !== true,
    )
    .run();
  return { userId, telegramId };
}

/** Gives them a completed purchase, which takes them out of the audience. */
async function buys(userId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO orders
         (public_id, user_id, kind, plan_id, unit_price_irr, discount_irr, total_irr,
          quantity, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1000000, 0, 1000000, 1, 'COMPLETED')`,
    )
    .bind(`zz-nudge-${userId}`, userId, await planId('sim-vip-1m-50'))
    .run();
}

async function nudged(telegramId: number): Promise<number> {
  return (await pendingNotifications()).filter((n) => n.chatId === telegramId).length;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
  invalidateShopSettings();
}

beforeAll(ensureCatalog);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // Nobody from another file may be in range, or the counts mean nothing.
  await db.prepare(`DELETE FROM orders`).run();
  await db.prepare(`DELETE FROM bot_notifications`).run();
  await db.prepare(`DELETE FROM users`).run();
  await setSetting('cron_nudge_never_bought', 'true');
  await setSetting('nudge_after_days', '3');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key LIKE 'cron_%'`).run();
  invalidateShopSettings();
});

describe('the switch', () => {
  it('sends nothing while it is off', async () => {
    await setSetting('cron_nudge_never_bought', 'false');
    const { telegramId } = await starter(30);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });

  it('is off by default, so a shop that never configures it stays quiet', async () => {
    // The row the migration writes is `false`. Asserted by deleting the row
    // entirely, which is the other way this can be «unconfigured»: the bot's
    // own fallback must be off too, or a database that cannot be read starts
    // messaging non-customers.
    await db
      .prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'cron_nudge_never_bought'`)
      .run();
    invalidateShopSettings();
    const { telegramId } = await starter(30);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });
});

describe('who gets it', () => {
  it('nudges somebody who started and never bought', async () => {
    const { telegramId } = await starter(10);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(1);
    const note = (await pendingNotifications()).find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('هنوز خریدی نکرده‌اید');
  });

  it('leaves somebody alone before the threshold', async () => {
    const { telegramId } = await starter(2);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });

  it('never nudges somebody who bought', async () => {
    const { userId, telegramId } = await starter(60);
    await buys(userId);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });

  it('respects the customer’s own notify switch', async () => {
    const { telegramId } = await starter(30, { muted: true });

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });

  it('does not nudge somebody the shop has blocked', async () => {
    // Deliberately unlike `warn.ts`, which ignores `status` on purpose: a
    // warning is about a service somebody paid for, so a wrong block must not
    // silence it. A nudge to somebody already ejected is only the shop
    // shouting at a person it threw out.
    const { telegramId } = await starter(30, { blocked: true });

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(0);
  });
});

describe('once, for ever', () => {
  it('does not nudge the same person twice', async () => {
    const { telegramId } = await starter(30);

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(1);
    expect(await nudgeNeverBought(db, NOW_MS)).toBe(0);
    expect(await nudged(telegramId)).toBe(1);
  });

  it('still does not, a year later', async () => {
    // The dedupe row is the record and nothing prunes `bot_notifications`, so
    // «once» has to mean once — not «once a batch» or «once until the queue is
    // tidied». Run at a clock a year on, which is where a sweep that only
    // filtered on «recently sent» would send a second one.
    const { telegramId } = await starter(30);
    expect(await nudgeNeverBought(db, NOW_MS)).toBe(1);

    expect(await nudgeNeverBought(db, NOW_MS + 365 * DAY)).toBe(0);
    expect(await nudged(telegramId)).toBe(1);
  });

  it('reaches new people rather than re-reading the ones it has done', async () => {
    // The failure this guards: without the `NOT EXISTS` on the queue in the
    // SELECT, every sweep would fill its batch with the same oldest rows and
    // nobody past the first batch would ever be nudged.
    const made: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const { telegramId } = await starter(60 - i);
      made.push(telegramId);
    }

    expect(await nudgeNeverBought(db, NOW_MS)).toBe(25);
    expect(await nudgeNeverBought(db, NOW_MS)).toBe(5);

    // Everybody, exactly once.
    const counts = await Promise.all(made.map(nudged));
    expect(counts.every((c) => c === 1)).toBe(true);
  });
});
