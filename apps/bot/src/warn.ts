/**
 * Telling a customer their service is about to run out.
 *
 * The thresholds are not invented. They are the live `setting` row on the
 * 2026-08-13 dump:
 *
 *     volumewarn   1     → warn at one gigabyte remaining
 *     daywarn      2     → warn at two days remaining
 *     cron_status  {"day":true,"volume":true,"remove":false,"remove_volume":false}
 *
 * The two `remove` flags being false is why this file only warns. Legacy can
 * also delete an expired account from the panel, and the admin has that switched
 * off; building it anyway would be building a thing that deletes customers'
 * services and is never asked to.
 *
 * Each warning is sent once. `subscriptions.notify` is the record — the same
 * column and the same two keys the PHP uses — and a renewal clears it, so the
 * next cycle of the service warns again.
 */

import type { D1Database } from '@shikoo/database';
import * as menu from './menu.js';
import { loadShopSettings } from './settings.js';
import type { Notification } from './settle.js';

/**
 * The thresholds when the settings cannot be read, in bytes and days.
 *
 * Production's own numbers, so a failed read warns exactly as the last release
 * did. The live values are `setting.volumewarn` and `setting.daywarn` and they
 * come from `loadShopSettings` — these two were plain constants until
 * 2026-08-16, which meant an admin could move either number in the panel and
 * the bot would keep warning on the old one with nothing looking broken.
 */
export const VOLUME_WARN_BYTES = 1024 ** 3;
export const DAYS_WARN = 2;

/**
 * A ceiling per pass, like every other sweep here. It runs every poll cycle,
 * so a backlog drains in a few minutes rather than making one cycle long.
 */
const BATCH = 50;

interface DueRow {
  id: number;
  telegram_id: number | null;
  plan_name_at_sale: string;
  expires_at: string | null;
  volume_gb: number | null;
  used_bytes: number | null;
  reason: 'time' | 'volume';
}

/**
 * Warns about services running out of days or gigabytes, once each.
 *
 * A service that is out of BOTH gets two messages, which is deliberate: they
 * are two different reasons and the customer is told the true one each time.
 * The alternative — one merged message — is a third string to keep correct and
 * it hides whichever limit they were not thinking about.
 */
export async function warnExpiringServices(
  db: D1Database,
  now: number = Date.now(),
): Promise<Notification[]> {
  // Read once per sweep, like the commission in `settle.ts`: it is shop-wide,
  // it is cached, and a sweep of fifty services should not ask fifty times.
  const { warnDays, warnVolumeGb } = await loadShopSettings(db);
  const { results } = await db
    .prepare(
      // Only what is genuinely still running: expired and exhausted services are
      // past warning, and a customer who has been told once is not told again.
      // `notify->>'x' IS DISTINCT FROM 'true'` rather than `= 'false'`, because
      // the key is absent on every row that has never been warned.
      `SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.expires_at,
              s.volume_gb, s.used_bytes, 'time' AS reason
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
        WHERE s.status = 'ACTIVE'
          AND u.notify_enabled
          AND u.status <> 'BLOCKED'
          AND s.notify->>'time' IS DISTINCT FROM 'true'
          AND s.expires_at IS NOT NULL
          AND s.expires_at > to_timestamp(?1 / 1000.0)
          AND s.expires_at <= to_timestamp(?1 / 1000.0) + make_interval(days => ?2)

        UNION ALL

        SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.expires_at,
               s.volume_gb, s.used_bytes, 'volume' AS reason
          FROM subscriptions s
          JOIN users u ON u.id = s.user_id
         WHERE s.status = 'ACTIVE'
           AND u.notify_enabled
           AND u.status <> 'BLOCKED'
           AND s.notify->>'volume' IS DISTINCT FROM 'true'
           AND s.volume_gb IS NOT NULL
           AND s.used_bytes IS NOT NULL
           -- Still has something left. A service already at zero has run out
           -- rather than being about to, and saying "nearly gone" then is worse
           -- than saying nothing.
           AND s.volume_gb * ?4 - s.used_bytes > 0
           AND s.volume_gb * ?4 - s.used_bytes <= ?3
           -- And not already over its date, or the customer gets a volume
           -- warning about a service that expired last week.
           AND (s.expires_at IS NULL OR s.expires_at > to_timestamp(?1 / 1000.0))

         LIMIT ?5`,
    )
    .bind(now, warnDays, warnVolumeGb * 1024 ** 3, 1024 ** 3, BATCH)
    .all<DueRow>();

  const notifications: Notification[] = [];

  for (const row of results ?? []) {
    // Claim the warning before producing it, guarded on the same condition the
    // SELECT used. Two sweeps overlapping — or one restarted mid-batch — then
    // send it once, and the failure mode is a warning lost rather than a
    // customer messaged twice about the same gigabyte.
    const claimed = await db
      .prepare(
        `UPDATE subscriptions
            SET notify = notify || jsonb_build_object(?2::text, true),
                updated_at = now()
          WHERE id = ?1 AND notify->>?2 IS DISTINCT FROM 'true'`,
      )
      .bind(row.id, row.reason)
      .run();
    if (claimed.meta.changes === 0) continue;
    if (row.telegram_id === null) continue;

    notifications.push({
      chatId: row.telegram_id,
      text:
        row.reason === 'time'
          ? menu.timeRunningOut(row.plan_name_at_sale, daysLeft(row.expires_at, now))
          : menu.volumeRunningOut(
              row.plan_name_at_sale,
              (row.volume_gb ?? 0) * 1024 ** 3 - (row.used_bytes ?? 0),
            ),
    });
  }

  return notifications;
}

/** Rounded up, so the last hours of a service read as "1 day" rather than "0". */
function daysLeft(expiresAt: string | null, now: number): number {
  if (expiresAt === null) return 0;
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 86_400_000));
}
