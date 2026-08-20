/**
 * The nightly report, against the real database.
 *
 * What is worth testing here is not the wording — it is that the numbers come
 * from the right day and are counted once. A report is read by somebody
 * deciding whether the shop had a good day, and a figure that is quietly wrong
 * is worse than no report at all, because nobody checks it against anything.
 *
 * The clock is pinned (rule 5) and every window assertion is measured against
 * `Asia/Tehran` boundaries computed by `@shikoo/domain`, not by this file
 * agreeing with `report.ts` about what a day is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tehranDayBoundsFromDate } from '@shikoo/domain';
import { buildDailyReport, sweepDailyReport } from '../src/report.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings, loadShopSettings } from '../src/settings.js';
import { blockForSpam } from '../src/spam.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

/** Mid-afternoon Tehran on the day being reported, so no boundary is grazed. */
const DAY = '2026-08-17';
/** 03:00 UTC on the following day — the loop's first look after it ended. */
const NEXT_MORNING = Date.UTC(2026, 7, 18, 3, 0, 0);

const CHANNEL = -1001234567890;

let seq = 0;
function ids() {
  seq += 1;
  return { telegramId: 880_000 + seq * 3 };
}

/**
 * A completed order stamped inside the reported day.
 *
 * `completed_at` is set explicitly rather than left to `now()`: the report
 * windows on it, and an order completed "now" would land in whatever real day
 * the suite happens to run on.
 */
async function completedOrder(opts: {
  kind: 'NEW_PURCHASE' | 'RENEWAL' | 'WALLET_TOPUP';
  irr: number;
  atMs: number;
  reseller?: boolean;
}): Promise<{ orderId: number; userId: number; telegramId: number }> {
  const { telegramId } = ids();
  const userId = await makeCustomer(telegramId, { reseller: opts.reseller ?? false });
  const plan = opts.kind === 'WALLET_TOPUP' ? null : await planId('sim-vip-1m-50');
  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status, completed_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, 'COMPLETED', to_timestamp(?6 / 1000.0))
       RETURNING id`,
    )
    .bind(`rep${seq}${opts.kind[0]}`, userId, opts.kind, plan, opts.irr, opts.atMs)
    .first<{ id: number }>();
  return { orderId: row!.id, userId, telegramId };
}

beforeEach(async () => {
  await ensureCatalog();
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'report:%'`).run();
  await db.prepare(`DELETE FROM orders WHERE public_id LIKE 'rep%'`).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'spam:%'`).run();
  invalidateShopSettings();
  vi.spyOn(Date, 'now').mockReturnValue(NEXT_MORNING);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the daily report', () => {
  it('counts only what happened inside the Tehran day', async () => {
    // The bounds come from the domain helper, so this test and the report
    // cannot agree with each other about a day that is wrong for both.
    const { start, end } = tehranDayBoundsFromDate(DAY);

    const inside = await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 7_000_000, atMs: start - 60_000 });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 9_000_000, atMs: end + 60_000 });

    const text = await buildDailyReport(db, DAY);

    // One sale, and the money is the one inside the window converted to toman.
    expect(text).toContain('فروش نو: <b>1</b>');
    expect(text).toContain('۱۰۰٬۰۰۰');
    // The neighbours' amounts must not appear anywhere in it.
    expect(text).not.toContain('۷۰۰٬۰۰۰');
    expect(text).not.toContain('۹۰۰٬۰۰۰');
    expect(inside.orderId).toBeGreaterThan(0);
  });

  it('tells a renewal from a sale, and leaves a top-up out of the sales total', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 2_000_000, atMs: start + 3_600_000 });
    await completedOrder({ kind: 'RENEWAL', irr: 1_000_000, atMs: start + 3_600_000 });
    await completedOrder({ kind: 'WALLET_TOPUP', irr: 5_000_000, atMs: start + 3_600_000 });

    const text = await buildDailyReport(db, DAY);

    expect(text).toContain('فروش نو: <b>1</b>');
    expect(text).toContain('تمدید: <b>1</b>');
    expect(text).toContain('شارژ کیف پول: <b>1</b>');
    // 200,000 + 100,000 toman. A top-up is money moving into a wallet, not a
    // sale, and adding it here would flatter every day it happened on.
    expect(text).toContain('مجموع فروش و تمدید: <b>۳۰۰٬۰۰۰ تومان</b>');
  });

  it('is queued once, however many times the loop asks', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });

    expect(await sweepDailyReport(db, CHANNEL)).toBe(true);
    expect(await sweepDailyReport(db, CHANNEL)).toBe(false);
    expect(await sweepDailyReport(db, CHANNEL)).toBe(false);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.chatId).toBe(CHANNEL);
    // Yesterday, not today: a report on a day still in progress is a number
    // that changes every time you look at it.
    expect(queued[0]?.dedupeKey).toBe(`report:${DAY}`);
  });

  it('does nothing at all without a channel', async () => {
    expect(await sweepDailyReport(db, null)).toBe(false);
    expect((await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'))).toHaveLength(0);
  });
});

/**
 * Which channel, asked once.
 *
 * Until 2026-08-20 there were two answers: this sweep read `REPORT_CHAT_ID`
 * from the environment and the flood guard read `setting.Channel_Report`, and
 * nothing made them agree. Nobody had noticed because the practice box has no
 * settings row and production has no environment variable — so each reader was
 * exercised in a different place and both looked right.
 */
describe('the report channel', () => {
  const SHOP_CHANNEL = -1001555444333;
  const ENV_FALLBACK = -1001222111000;

  async function setChannel(id: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'Channel_Report', ?1::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(String(id)))
      .run();
    invalidateShopSettings();
  }

  it('prefers the shop’s own row over the environment', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });
    await setChannel(SHOP_CHANNEL);

    expect(await sweepDailyReport(db, ENV_FALLBACK)).toBe(true);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued[0]?.chatId).toBe(SHOP_CHANNEL);
  });

  it('uses the environment only when the shop has no row', async () => {
    // The practice box: its settings table has never been migrated.
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });

    expect(await sweepDailyReport(db, ENV_FALLBACK)).toBe(true);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued[0]?.chatId).toBe(ENV_FALLBACK);
  });

  it('sends the nightly report and a spam block to the SAME channel', async () => {
    // The invariant the split violated. Both readers are handed a different
    // environment fallback here, so anything still reading the environment
    // lands somewhere the other one did not.
    const { start } = tehranDayBoundsFromDate(DAY);
    const { userId, telegramId } = await completedOrder({
      kind: 'NEW_PURCHASE',
      irr: 1_000_000,
      atMs: start + 60_000,
    });
    await setChannel(SHOP_CHANNEL);

    await sweepDailyReport(db, ENV_FALLBACK);
    const { reportChatId } = await loadShopSettings(db);
    await db.withSession((tx) =>
      blockForSpam(tx, { userId, telegramId, updateId: 987_654_321, reportChatId }),
    );

    const notes = await pendingNotifications();
    const report = notes.find((n) => n.dedupeKey.startsWith('report:'));
    const spam = notes.find((n) => n.dedupeKey.startsWith('spam:'));
    expect(report?.chatId).toBe(SHOP_CHANNEL);
    expect(spam?.chatId).toBe(SHOP_CHANNEL);
    expect(report?.chatId).toBe(spam?.chatId);
  });
});
