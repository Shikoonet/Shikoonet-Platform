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
import { tehranDateStringFromMs, tehranDayBoundsFromDate } from '@shikoo/domain';
import { enqueue } from './notify.js';
import { loadShopSettings } from './settings.js';

/** How many resellers the ranking names, matching the legacy's `LIMIT 3`. */
const TOP_RESELLERS = 3;

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
): Promise<{ name: string; count: number; irr: number; gb: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.provider_name_at_sale AS name,
              count(*)::int           AS n,
              COALESCE(sum(s.price_irr), 0)  AS irr,
              COALESCE(sum(s.volume_gb), 0)  AS gb
         FROM subscriptions s
        WHERE s.purchased_at >= to_timestamp(?1 / 1000.0)
          AND s.purchased_at <  to_timestamp(?2 / 1000.0)
        GROUP BY s.provider_name_at_sale
        ORDER BY irr DESC`,
    )
    .bind(start, end)
    .all<{ name: string | null; n: number; irr: number; gb: number }>();
  return (results ?? []).map((r) => ({
    name: r.name ?? '—',
    count: r.n,
    irr: Number(r.irr),
    gb: Number(r.gb),
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

/** IRR to the toman a Persian reader expects, grouped. */
function toman(irr: number): string {
  return Math.round(irr / 10).toLocaleString('fa-IR');
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
    lines.push('', '🖥 به تفکیک لوکیشن');
    for (const p of panels) {
      lines.push(`• ${p.name}: ${p.count} سرویس — ${toman(p.irr)} تومان — ${p.gb} گیگ`);
    }
  }

  if (resellers.length > 0) {
    lines.push('', '🏅 نمایندگان برتر امروز');
    for (const r of resellers) {
      lines.push(`• ${r.username ? '@' + r.username : r.telegramId}: ${toman(r.irr)} تومان`);
    }
  }

  return lines.join('\n');
}

/**
 * Queues yesterday's report, once.
 *
 * Called from the poll loop, so it is asked roughly every twenty-five seconds
 * and must be cheap when there is nothing to do — which is why the dedupe key
 * is checked before the report is built rather than after. Building it is six
 * aggregate queries; asking whether it exists is one primary-key hit.
 *
 * The key is the Tehran date, so the day the report covers is what makes it
 * unique. A restart, an overlapping sweep, or two pollers during a rolling
 * deploy all produce the same key and `ON CONFLICT DO NOTHING` keeps one.
 *
 * Returns whether a report was queued, which is what the caller logs.
 */
export async function sweepDailyReport(db: D1Database, now: number = Date.now()): Promise<boolean> {
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
  if (chatId === null) return false;

  // Yesterday in Tehran: the most recent day that is entirely over. Reporting
  // on today would be a partial day whose number changes every time you look.
  const dateStr = tehranDateStringFromMs(now - 24 * 60 * 60 * 1000);
  const key = `report:${dateStr}`;

  const already = await db
    .prepare(`SELECT 1 AS x FROM bot_notifications WHERE dedupe_key = ?1`)
    .bind(key)
    .first<{ x: number }>();
  if (already) return false;

  const text = await buildDailyReport(db, dateStr);
  // «🌙 گزارش شبانه». Null until somebody makes the topics, and null is a
  // message in the group's General topic — exactly where it goes today.
  await db.withSession((tx) =>
    enqueue(tx, { dedupeKey: key, chatId, text, threadId: reportTopics.reportnight }),
  );
  return true;
}
