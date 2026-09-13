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
import {
  invalidateShopSettings,
  loadShopSettings,
  setReportChatIdFallback,
} from '../src/settings.js';
import { blockForSpam } from '../src/spam.js';
import { createTelegramApi } from '../src/telegram.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';

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
  kind: 'NEW_PURCHASE' | 'RENEWAL' | 'WALLET_TOPUP' | 'TRIAL';
  irr: number;
  atMs: number;
  reseller?: boolean;
  /** Deliver it too, onto a named panel — what the per-panel block reads. */
  onPanel?: string;
}): Promise<{ orderId: number; userId: number; telegramId: number }> {
  const { telegramId } = ids();
  const userId = await makeCustomer(telegramId, { reseller: opts.reseller ?? false });
  const plan = opts.kind === 'WALLET_TOPUP' ? null : await planId('sim-vip-1m-50');
  const row = await db
    .prepare(
      // `provider_id` for the sake of `orders_trial_is_free`, which requires a
      // TRIAL to be free AND to name the panel it came from.
      `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                           unit_price_irr, total_irr, status, completed_at,
                           provider_id)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, 'COMPLETED', to_timestamp(?6 / 1000.0), ?7)
       RETURNING id`,
    )
    .bind(
      `rep${seq}${opts.kind[0]}`,
      userId,
      opts.kind,
      plan,
      opts.irr,
      opts.atMs,
      opts.kind === 'TRIAL' ? await providerId('sim-vip') : null,
    )
    .first<{ id: number }>();
  if (opts.onPanel !== undefined) {
    await db
      .prepare(
        `INSERT INTO subscriptions (public_id, user_id, plan_id, order_id,
                                    provider_name_at_sale, plan_name_at_sale,
                                    price_irr, volume_gb, status, purchased_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'plan', ?6, 10, 'ACTIVE',
                 to_timestamp(?7 / 1000.0))`,
      )
      .bind(`reps${seq}`, userId, plan, row!.id, opts.onPanel, opts.irr, opts.atMs)
      .run();
  }
  return { orderId: row!.id, userId, telegramId };
}

/**
 * Every night before the reported day was sent, so the sweep is looking at an
 * ordinary morning that owes exactly one report. Without this the table is
 * empty — a shop that has never reported — and the sweep rightly queues the
 * whole window.
 */
async function ordinaryMorning(): Promise<void> {
  for (let back = 1; back < 7; back++) {
    const night = new Date(Date.UTC(2026, 7, 17 - back)).toISOString().slice(0, 10);
    await db
      .prepare(
        `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status)
         VALUES (?1, ?2, 'sent earlier', 'SENT') ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(`report:${night}`, CHANNEL)
      .run();
  }
}

beforeEach(async () => {
  await ensureCatalog();
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'report:%'`).run();
  await db.prepare(`DELETE FROM subscriptions WHERE public_id LIKE 'reps%'`).run();
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
  it('breaks new sales down by panel, and a free trial is not a sale', async () => {
    /*
     * The per-panel block was rendered by no test at all — `completedOrder`
     * never wrote a subscription, so `perPanel()` returned nothing and the
     * whole block was skipped. Its heading could say anything.
     *
     * What it says now is «فروش نو به تفکیک لوکیشن», and this is what makes
     * that true: a TRIAL writes a subscription and is not a sale, so it used to
     * appear here while «🛒 فروش نو» above — which counts NEW_PURCHASE orders —
     * never saw it. The two lines disagreed about the same panel on any day a
     * trial was handed out.
     */
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({
      kind: 'NEW_PURCHASE',
      irr: 1_000_000,
      atMs: start + 60_000,
      onPanel: 'zz-report-panel',
    });
    await completedOrder({
      kind: 'TRIAL',
      irr: 0,
      atMs: start + 120_000,
      onPanel: 'zz-report-panel',
    });

    const text = await buildDailyReport(db, DAY);

    expect(text).toContain('zz-report-panel');
    // One sale on that panel, counted the same way in both lines.
    expect(text).toContain('فروش نو: 1');
    expect(text).toMatch(/zz-report-panel[^\n]*\b1\b/);
  });

  it('counts only what happened inside the Tehran day', async () => {
    // The bounds come from the domain helper, so this test and the report
    // cannot agree with each other about a day that is wrong for both.
    const { start, end } = tehranDayBoundsFromDate(DAY);

    const inside = await completedOrder({
      kind: 'NEW_PURCHASE',
      irr: 1_000_000,
      atMs: start + 60_000,
    });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 7_000_000, atMs: start - 60_000 });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 9_000_000, atMs: end + 60_000 });

    const text = await buildDailyReport(db, DAY);

    // One sale, and the money is the one inside the window converted to toman.
    //
    // Latin digits, because this report now goes through `formatToman` like
    // every other amount in the shop. It used to divide by ten and group with
    // `fa-IR` on its own, so the one message the admin reads was the only place
    // in the product spelling money in Persian digits.
    expect(text).toContain('فروش نو: 1');
    expect(text).toContain('100,000');
    // The neighbours' amounts must not appear anywhere in it.
    expect(text).not.toContain('700,000');
    expect(text).not.toContain('900,000');
    expect(inside.orderId).toBeGreaterThan(0);
  });

  it('tells a renewal from a sale, and leaves a top-up out of the sales total', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 2_000_000, atMs: start + 3_600_000 });
    await completedOrder({ kind: 'RENEWAL', irr: 1_000_000, atMs: start + 3_600_000 });
    await completedOrder({ kind: 'WALLET_TOPUP', irr: 5_000_000, atMs: start + 3_600_000 });

    const text = await buildDailyReport(db, DAY);

    expect(text).toContain('فروش نو: 1');
    expect(text).toContain('تمدید: 1');
    expect(text).toContain('شارژ کیف پول: 1');
    // 200,000 + 100,000 toman. A top-up is money moving into a wallet, not a
    // sale, and adding it here would flatter every day it happened on.
    expect(text).toContain('مجموع فروش و تمدید: 300,000 تومان');
  });

  it('is queued once, however many times the loop asks', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });

    await ordinaryMorning();
    setReportChatIdFallback(CHANNEL);
    expect(await sweepDailyReport(db)).toEqual([DAY]);
    expect(await sweepDailyReport(db)).toEqual([]);
    expect(await sweepDailyReport(db)).toEqual([]);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.chatId).toBe(CHANNEL);
    // Yesterday, not today: a report on a day still in progress is a number
    // that changes every time you look at it.
    expect(queued[0]?.dedupeKey).toBe(`report:${DAY}`);
  });

  it('does nothing at all without a channel', async () => {
    setReportChatIdFallback(null);
    expect(await sweepDailyReport(db)).toEqual([]);
    expect(
      (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:')),
    ).toHaveLength(0);
  });

  /**
   * A missed night is made up — issue #179.
   *
   * Only yesterday was ever asked about, so a bot down for three days lost two
   * reports for good. The `report:<date>` key already made a catch-up safe;
   * nothing did one.
   */
  it('catches up the nights it missed, oldest first, and no night that was sent', async () => {
    setReportChatIdFallback(CHANNEL);
    // Every night up to the outage was sent as usual.
    for (const sent of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
      await db
        .prepare(
          `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status)
           VALUES (?1, ?2, 'sent earlier', 'SENT')`,
        )
        .bind(`report:${sent}`, CHANNEL)
        .run();
    }

    // The loop's first look after three days down: 08-15, 08-16 and 08-17 are
    // all owed, and nothing before them is.
    expect(await sweepDailyReport(db)).toEqual(['2026-08-15', '2026-08-16', '2026-08-17']);
    const queued = (await pendingNotifications())
      .filter((n) => n.dedupeKey.startsWith('report:'))
      .map((n) => n.dedupeKey);
    expect(queued).toEqual(['report:2026-08-15', 'report:2026-08-16', 'report:2026-08-17']);

    // And once, like the ordinary night.
    expect(await sweepDailyReport(db)).toEqual([]);
  });

  it('fills a hole behind a night that was sent', async () => {
    // The deploy morning: the old code queued one night mid-outage, so the
    // last SENT row is not the edge of the gap. A walk that stopped at it
    // would leave 08-14 and 08-15 unsent for ever.
    setReportChatIdFallback(CHANNEL);
    for (const sent of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-16']) {
      await db
        .prepare(
          `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status)
           VALUES (?1, ?2, 'sent earlier', 'SENT')`,
        )
        .bind(`report:${sent}`, CHANNEL)
        .run();
    }
    expect(await sweepDailyReport(db)).toEqual(['2026-08-14', '2026-08-15', '2026-08-17']);
  });

  it('after a week or more down, makes up the whole window and no more', async () => {
    // Seven missing with an eighth present is an outage, not a first run —
    // the two states an empty window used to conflate, one of which lost six
    // nights for good. The cap is the cap: 08-10 stays unsent, and the log
    // says so.
    setReportChatIdFallback(CHANNEL);
    await db
      .prepare(
        `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status)
         VALUES ('report:2026-08-09', ?1, 'sent earlier', 'SENT')`,
      )
      .bind(CHANNEL)
      .run();
    expect(await sweepDailyReport(db)).toEqual([
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
    ]);
  });

  it('gives a shop that has never sent a report the whole window, once', async () => {
    // No `report:<date>` row at all — `beforeEach` deletes them. Seven nights
    // on the first morning is the documented price of not telling «never
    // sent» from «down a week»; what matters is that it happens once and that
    // the next cycle is quiet.
    setReportChatIdFallback(CHANNEL);
    expect(await sweepDailyReport(db)).toHaveLength(7);
    expect(await sweepDailyReport(db)).toEqual([]);
  });

  it('says «نامحدود» for a panel that sold only unmetered services, and counts them beside a sum', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-unmetered' });
    await db.prepare(`UPDATE subscriptions SET volume_gb = NULL WHERE public_id = ?1`).bind(`reps${seq}`).run();
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-mixed' });
    await db.prepare(`UPDATE subscriptions SET volume_gb = NULL WHERE public_id = ?1`).bind(`reps${seq}`).run();
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-mixed' });

    const text = await buildDailyReport(db, DAY);

    // sum() skips NULL and COALESCE used to fold the all-NULL case to zero, so
    // a panel that sold two unlimited services printed «0 گیگ».
    expect(text).toMatch(/zz-unmetered[^\n]*نامحدود/);
    expect(text).not.toMatch(/zz-unmetered[^\n]*0 گیگ/);
    expect(text).toMatch(/zz-mixed[^\n]*10 گیگ \+ 1 نامحدود/);
  });

  it('adds the panel gigabytes up with the shop’s own formatter', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    // Two 10 GB services and one of 1000.5 — a sum the raw number prints as
    // «1020.5 گیگ» and every customer screen prints as «1,020.5 گیگ».
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-gb-panel' });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-gb-panel' });
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000, onPanel: 'zz-gb-panel' });
    await db
      .prepare(`UPDATE subscriptions SET volume_gb = 1000.5 WHERE public_id = ?1`)
      .bind(`reps${seq}`)
      .run();

    const text = await buildDailyReport(db, DAY);

    expect(text).toMatch(/zz-gb-panel[^\n]*1,020\.5 گیگ/);
    expect(text).not.toContain('1020.5');
  });

  it('names a reseller with no @username as a person, not a bare number', async () => {
    const { start } = tehranDayBoundsFromDate(DAY);
    const { telegramId } = await completedOrder({
      kind: 'NEW_PURCHASE',
      irr: 3_000_000,
      atMs: start + 60_000,
      reseller: true,
    });
    await db.prepare(`UPDATE users SET username = NULL WHERE telegram_id = ?1`).bind(telegramId).run();

    const text = await buildDailyReport(db, DAY);

    expect(text).toContain(`• کاربر ${telegramId}: 300,000 تومان`);
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
 *
 * That day fixed half of it: both readers were pointed at
 * `ShopSettings.reportChatId`, and this sweep kept an env fallback the flood
 * guard could not see. So on a box with no settings row and the variable set —
 * the practice box, exactly — the nightly report still went somewhere a block
 * report did not. The test below asserted "the same channel" while setting the
 * shop row first, which is the one arrangement where the split cannot show.
 * The fallback lives in `loadShopSettings` now, and the test sets no row.
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

    await ordinaryMorning();
    setReportChatIdFallback(ENV_FALLBACK);
    expect(await sweepDailyReport(db)).toEqual([DAY]);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued[0]?.chatId).toBe(SHOP_CHANNEL);
  });

  it('uses the environment only when the shop has no row', async () => {
    // The practice box: its settings table has never been migrated.
    const { start } = tehranDayBoundsFromDate(DAY);
    await completedOrder({ kind: 'NEW_PURCHASE', irr: 1_000_000, atMs: start + 60_000 });

    await ordinaryMorning();
    setReportChatIdFallback(ENV_FALLBACK);
    expect(await sweepDailyReport(db)).toEqual([DAY]);

    const queued = (await pendingNotifications()).filter((n) => n.dedupeKey.startsWith('report:'));
    expect(queued[0]?.chatId).toBe(ENV_FALLBACK);
  });

  it('sends the nightly report and a spam block to the SAME channel', async () => {
    // NO shop row, and a fallback set — the practice box, and the one
    // arrangement where the two readers used to disagree. Setting the row first
    // (which this test did until 2026-08-21) makes both readers agree by
    // accident and proves nothing.
    const { start } = tehranDayBoundsFromDate(DAY);
    const { userId, telegramId } = await completedOrder({
      kind: 'NEW_PURCHASE',
      irr: 1_000_000,
      atMs: start + 60_000,
    });
    setReportChatIdFallback(ENV_FALLBACK);

    await sweepDailyReport(db);
    const { reportChatId } = await loadShopSettings(db);
    await db.withSession((tx) =>
      blockForSpam(tx, { userId, telegramId, updateId: 987_654_321, reportChatId }),
    );

    const notes = await pendingNotifications();
    const report = notes.find((n) => n.dedupeKey.startsWith('report:'));
    const spam = notes.find((n) => n.dedupeKey.startsWith('spam:'));
    expect(report?.chatId).toBe(ENV_FALLBACK);
    expect(spam?.chatId).toBe(ENV_FALLBACK);
    expect(report?.chatId).toBe(spam?.chatId);
  });
});

/**
 * The report as the admin actually receives it.
 *
 * Every assertion in this file until 2026-08-21 read the string
 * `buildDailyReport` returns, which is one step short of the thing that
 * matters. The report was built with `<b>…</b>` in it and `telegram.ts` sends
 * `parse_mode` only for a message containing a custom emoji — so the admin was
 * shown the tags. A whole file of green tests, none of which could see it,
 * because none of them followed the message to the boundary.
 */
describe('what leaves for Telegram', () => {
  it('carries no markup and asks for no parse_mode', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const api = createTelegramApi({ token: 't', baseUrl: 'https://x.test', fetch: fetchImpl });
    await api.sendMessage(CHANNEL, await buildDailyReport(db, DAY));

    expect(bodies).toHaveLength(1);
    // No `parse_mode`, which is the house rule (`menu.ts:938`) — so any tag in
    // the text would be shown to the reader exactly as written.
    expect(bodies[0]!['parse_mode']).toBeUndefined();
    expect(String(bodies[0]!['text'])).not.toContain('<');
    // And it is still the report, not an empty string that trivially passes.
    expect(String(bodies[0]!['text'])).toContain('گزارش روز');
  });
});
