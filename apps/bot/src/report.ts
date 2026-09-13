/**
 * The shop's day, in one message.
 *
 * Parity with `legacy/mirzabot-php/cronbot/statusday.php`, which posts three
 * messages to a report channel every night: the day's figures, the panels
 * broken down, and the resellers who spent the most.
 *
 * ## Two deliberate differences from the PHP
 *
 * **It runs after the day ends, not at 23:45.** The legacy fires at 23:45 and
 * then counts `00:00:00` to `23:59:59` — so the last fifteen minutes of every
 * day are queried and have not happened yet. Nobody would notice, and the shop
 * has been under-reporting its late evening for years. Here the window is a
 * whole Tehran day and the report is built once that day is over.
 *
 * **Where it goes** is `ShopSettings.reportChatId`, from the shop's own
 * `setting.Channel_Report`, with `REPORT_CHAT_ID` as the fallback for a
 * database whose settings have never been migrated. The flood guard reads the
 * same field.
 *
 * **It goes through `bot_notifications`.** The legacy calls `sendmessage`
 * straight from cron, so a Telegram hiccup at 23:45 loses that night's report
 * for good. Queued, it is retried, and `report:<date>` as the dedupe key is
 * what stops a restart or an overlapping sweep sending it twice.
 *
 * One message rather than three, because three arrive out of order often enough
 * to be confusing and there is nothing to gain from splitting them.
 */

import type { D1Database } from '@shikoo/database';
import { tehranAdjacentDay, tehranDateStringFromMs, tehranDayBoundsFromDate } from '@shikoo/domain';
import { enqueue } from './notify.js';
import { loadShopSettings } from './settings.js';
import { volumeText } from './menu.js';
import { formatToman } from './money.js';

/** How many resellers the ranking names, matching the legacy's `LIMIT 3`. */
const TOP_RESELLERS = 3;

/**
 * How many nights back the sweep looks for a report it never sent.
 *
 * A bot down for three days used to lose two reports for good: only yesterday
 * was ever asked about, and yesterday moves on. The `report:<date>` key is
 * what makes catching up safe — a night already queued is simply not queued
 * again — so this is the cap on how far a comeback reaches, not a schedule. A
 * week: longer than any outage that has happened, short enough that a shop
 * does not get a month of nights at once. An outage longer than this loses
 * the nights beyond it.
 *
 * A shop that has never sent a report gets the whole window on its first
 * morning — seven mostly-empty nights, once. That is deliberate: telling
 * «never sent» from «down a week» needs a scan of every notification ever
 * written, on every cycle for a week, to save one screenful of zeros on the
 * day the bot is installed.
 */
const CATCH_UP_DAYS = 7;

interface DayTotals {
  sales: number;
  salesIrr: number;
  renewals: number;
  renewalsIrr: number;
  topups: number;
  topupsIrr: number;
  newCustomers: number;
}

/**
 * What the shop did on one Tehran day.
 *
 * Counted from `orders`, which is where a sale becomes real, rather than from
 * `payments`: a wallet purchase has no payment row of its own and would vanish
 * from the count. `COMPLETED` only — an order that failed and refunded is not
 * a sale, and one still in flight is not one yet.
 */
async function totals(db: D1Database, start: number, end: number): Promise<DayTotals> {
  const row = await db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE kind = 'NEW_PURCHASE')::int              AS sales,
         COALESCE(sum(total_irr) FILTER (WHERE kind = 'NEW_PURCHASE'), 0) AS sales_irr,
         count(*) FILTER (WHERE kind = 'RENEWAL')::int                   AS renewals,
         COALESCE(sum(total_irr) FILTER (WHERE kind = 'RENEWAL'), 0)      AS renewals_irr,
         count(*) FILTER (WHERE kind = 'WALLET_TOPUP')::int              AS topups,
         COALESCE(sum(total_irr) FILTER (WHERE kind = 'WALLET_TOPUP'), 0) AS topups_irr
       FROM orders
       WHERE status = 'COMPLETED'
         AND completed_at >= to_timestamp(?1 / 1000.0)
         AND completed_at <  to_timestamp(?2 / 1000.0)`,
    )
    .bind(start, end)
    .first<{
      sales: number;
      sales_irr: number;
      renewals: number;
      renewals_irr: number;
      topups: number;
      topups_irr: number;
    }>();

  const joined = await db
    .prepare(
      `SELECT count(*)::int AS n FROM users
        WHERE registered_at >= to_timestamp(?1 / 1000.0)
          AND registered_at <  to_timestamp(?2 / 1000.0)`,
    )
    .bind(start, end)
    .first<{ n: number }>();

  return {
    sales: row?.sales ?? 0,
    salesIrr: Number(row?.sales_irr ?? 0),
    renewals: row?.renewals ?? 0,
    renewalsIrr: Number(row?.renewals_irr ?? 0),
    topups: row?.topups ?? 0,
    topupsIrr: Number(row?.topups_irr ?? 0),
    newCustomers: joined?.n ?? 0,
  };
}

/**
 * Per panel, so the shop can see which location is carrying the day.
 *
 * Read from `subscriptions`, not from the plan's provider: the provider a
 * service actually landed on is the one recorded on the subscription, and a
 * delivery from the shelf can differ from what the plan pointed at.
 */
async function perPanel(
  db: D1Database,
  start: number,
  end: number,
): Promise<{ name: string; count: number; irr: number; gb: number | null; unmetered: number }[]> {
  const { results } = await db
    .prepare(
      // volume_gb is NULL for an unmetered service, and sum() skips it — so the
      // sum is the METERED gigabytes, NULL when every service sold here was
      // unmetered, and the count beside it says how many the sum leaves out.
      // Folding NULL to 0 here used to print «0 گیگ» for a panel that sold two
      // unlimited services.
      `SELECT s.provider_name_at_sale AS name,
              count(*)::int           AS n,
              COALESCE(sum(s.price_irr), 0)  AS irr,
              sum(s.volume_gb)               AS gb,
              count(*) FILTER (WHERE s.volume_gb IS NULL)::int AS unmetered
         FROM subscriptions s
         -- LEFT, so a subscription carried over by the import — which has no
         -- order at all — still counts. What the join is here for is the one
         -- kind that would otherwise make the heading false: a TRIAL writes a
         -- subscription and is not a sale, so it appeared in this block while
         -- «🛒 فروش نو» above counts NEW_PURCHASE orders and never saw it. A
         -- renewal writes no subscription row, so it was never in either.
         LEFT JOIN orders o ON o.id = s.order_id
        WHERE s.purchased_at >= to_timestamp(?1 / 1000.0)
          AND s.purchased_at <  to_timestamp(?2 / 1000.0)
          AND (o.kind IS NULL OR o.kind = 'NEW_PURCHASE')
        GROUP BY s.provider_name_at_sale
        ORDER BY irr DESC`,
    )
    .bind(start, end)
    .all<{ name: string | null; n: number; irr: number; gb: number | null; unmetered: number }>();
  return (results ?? []).map((r) => ({
    name: r.name ?? '—',
    count: r.n,
    irr: Number(r.irr),
    gb: r.gb === null ? null : Number(r.gb),
    unmetered: r.unmetered,
  }));
}

/** The resellers who spent the most today. */
async function topResellers(
  db: D1Database,
  start: number,
  end: number,
): Promise<{ telegramId: number; username: string | null; irr: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT u.telegram_id, u.username, COALESCE(sum(o.total_irr), 0) AS irr
         FROM orders o
         JOIN users u ON u.id = o.user_id
        WHERE u.is_reseller = true
          AND o.status = 'COMPLETED'
          AND o.kind <> 'WALLET_TOPUP'
          AND o.completed_at >= to_timestamp(?1 / 1000.0)
          AND o.completed_at <  to_timestamp(?2 / 1000.0)
        GROUP BY u.telegram_id, u.username
        ORDER BY irr DESC
        LIMIT ?3`,
    )
    .bind(start, end, TOP_RESELLERS)
    .all<{ telegram_id: number; username: string | null; irr: number }>();
  return (results ?? []).map((r) => ({
    telegramId: r.telegram_id,
    username: r.username,
    irr: Number(r.irr),
  }));
}

/**
 * The shop's one money formatter, without its «تومان» suffix.
 *
 * This file used to divide by ten itself and group with `fa-IR`, which put
 * Persian digits — «۱۹۵٬۰۰۰» — in the one message the admin reads, while every
 * number on every customer screen is Latin because `formatToman` says so and
 * explains why. Two spellings of the same amount in one shop, and only the
 * nightly report used the ad-hoc one.
 */
function toman(irr: number): string {
  return formatToman(irr).replace(' تومان', '');
}

/** The message itself, built from a day that is already over. */
export async function buildDailyReport(db: D1Database, dateStr: string): Promise<string> {
  const { start, end } = tehranDayBoundsFromDate(dateStr);
  const [day, panels, resellers] = await Promise.all([
    totals(db, start, end),
    perPanel(db, start, end),
    topResellers(db, start, end),
  ]);

  // No markup, because nothing downstream renders it.
  //
  // This built `<b>…</b>` until 2026-08-21 and every one of those tags was
  // shown to the admin literally. `telegram.ts` only sends `parse_mode` for a
  // message containing a custom emoji — `hasCustomEmoji` matches `<tg-emoji>`
  // and nothing else — and the house rule is stated outright at `menu.ts:938`:
  // "No parse_mode anywhere in this bot, so emphasis is quotation marks."
  //
  // The tests could not see it because they all asserted the string this
  // function builds. Nothing drove a report through `sendMessage`, which is
  // where the decision is made; one does now.
  const lines = [
    `📊 گزارش روز ${dateStr}`,
    '',
    `🛒 فروش نو: ${day.sales} — ${toman(day.salesIrr)} تومان`,
    `🔄 تمدید: ${day.renewals} — ${toman(day.renewalsIrr)} تومان`,
    `👛 شارژ کیف پول: ${day.topups} — ${toman(day.topupsIrr)} تومان`,
    `👤 مشتری جدید: ${day.newCustomers}`,
    '',
    `💰 مجموع فروش و تمدید: ${toman(day.salesIrr + day.renewalsIrr)} تومان`,
  ];

  if (panels.length > 0) {
    // «فروش نو», not «فروش», and the word is the whole fix.
    //
    // The block counts SUBSCRIPTIONS on `purchased_at`, which is written once
    // when a service is first delivered and never again — the renewal UPDATE in
    // `provision.ts` touches neither `purchased_at` nor `price_irr`. The total
    // directly above it counts ORDERS and includes renewals. So on a shop whose
    // revenue is mostly renewals the two disagreed by most of the day's
    // takings, with nothing on screen saying why, and an admin reading down the
    // message had every reason to think the panel lines should sum to the line
    // above them.
    //
    // Naming what it counts closes that without changing what it counts, and
    // keeps the legacy meaning: the PHP report is per-panel NEW services too.
    // If the shop would rather see sales and renewals together per panel, that
    // is a different query — build it from `orders` joined to the subscription
    // it targets, so both halves answer from the same table — and a different
    // decision, because it also has to say what a TRIAL counts as.
    lines.push('', '🖥 فروش نو به تفکیک لوکیشن');
    for (const p of panels) {
      // `volumeText`, not the raw sum: three panels' worth of numeric(12,3)
      // adds up to «1500.5», and the one formatter every customer screen uses
      // is the one the admin's screen should use too. Its «نامحدود» is the
      // all-unmetered panel; a mixed one says how many the sum leaves out.
      const mixed = p.gb !== null && p.unmetered > 0 ? ` + ${p.unmetered} نامحدود` : '';
      lines.push(
        `• ${p.name}: ${p.count} سرویس — ${toman(p.irr)} تومان — ${volumeText(p.gb)}${mixed}`,
      );
    }
  }

  if (resellers.length > 0) {
    lines.push('', '🏅 نمایندگان برتر امروز');
    for (const r of resellers) {
      // A reseller with no @username is named as a person, not as a bare
      // number in a leaderboard — «7462913» beside «@shop_ali» reads as a row
      // that lost its name.
      const who = r.username ? '@' + r.username : `کاربر ${r.telegramId}`;
      lines.push(`• ${who}: ${toman(r.irr)} تومان`);
    }
  }

  return lines.join('\n');
}

/**
 * Queues yesterday's report, once — and any night before it that was missed.
 *
 * Called from the poll loop, so it is asked roughly every twenty-five seconds
 * and must be cheap when there is nothing to do — which is why the dedupe keys
 * are checked before any report is built rather than after. Building one is
 * six aggregate queries; asking which of seven exist is one index read.
 *
 * The key is the Tehran date, so the day the report covers is what makes it
 * unique. A restart, an overlapping sweep, or two pollers during a rolling
 * deploy all produce the same key and `ON CONFLICT DO NOTHING` keeps one.
 *
 * Returns the nights it queued, oldest first — usually none, usually one.
 */
export async function sweepDailyReport(db: D1Database, now: number = Date.now()): Promise<string[]> {
  // One question, one answer — and this time the environment is inside the
  // answer rather than beside it.
  //
  // On 2026-08-20 the destination was unified on `ShopSettings.reportChatId`,
  // and that was only half of it: this function still took an env fallback the
  // flood guard could not see, so on any box where the settings row is missing
  // and `REPORT_CHAT_ID` is set — the practice box, exactly — the nightly
  // report went to the environment's channel and a block report went nowhere.
  // The fallback is applied in `loadShopSettings` now, so there is one value
  // and every reader gets it.
  const { reportChatId: chatId, reportTopics } = await loadShopSettings(db);
  // No channel configured is not an error — the legacy skips the send the same
  // way, and a shop that does not want the report should not be paying for six
  // aggregate queries a night to not send it.
  if (chatId === null) return [];

  // Yesterday in Tehran: the most recent day that is entirely over. Reporting
  // on today would be a partial day whose number changes every time you look.
  //
  // And the nights before it that were never sent. One question for the whole
  // window rather than a walk that stops at the first night found: a walk
  // cannot see a hole behind a night that WAS sent — the deploy morning, when
  // the old code had queued one night mid-outage — and every absent key in the
  // window is a night the channel is owed. Oldest first, so it reads in order.
  const yesterday = tehranDateStringFromMs(now - 24 * 60 * 60 * 1000);
  const window = Array.from({ length: CATCH_UP_DAYS }, (_, i) =>
    tehranAdjacentDay(yesterday, i - (CATCH_UP_DAYS - 1)),
  );
  const { results } = await db
    .prepare(`SELECT dedupe_key FROM bot_notifications WHERE dedupe_key = ANY(?1)`)
    .bind(window.map((d) => `report:${d}`))
    .all<{ dedupe_key: string }>();
  const sent = new Set((results ?? []).map((r) => r.dedupe_key));
  const missing = window.filter((d) => !sent.has(`report:${d}`));

  for (const dateStr of missing) {
    const text = await buildDailyReport(db, dateStr);
    // «🌙 گزارش شبانه». Null until somebody makes the topics, and null is a
    // message in the group's General topic — exactly where it goes today.
    await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: `report:${dateStr}`,
        chatId,
        text,
        threadId: reportTopics.reportnight,
      }),
    );
  }
  return missing;
}
