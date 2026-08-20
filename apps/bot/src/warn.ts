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
 *
 * ## The third message, added 2026-08-19
 *
 * `unused` is not a warning about running out; it is the opposite. A customer
 * bought a service and never connected to it. Mirzabot sends this from
 * `cronbot/on_hold.php`, and it lives here rather than in a file of its own
 * because the hard part is not the query — it is the claim-and-enqueue below,
 * which was already wrong once and must not exist twice.
 */

import type { D1Database } from '@shikoo/database';
import * as menu from './menu.js';
import { loadShopSettings, settingText } from './settings.js';
import { enqueue } from './notify.js';

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
  purchased_at: string;
  reason: 'time' | 'volume' | 'unused';
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
): Promise<number> {
  // Read once per sweep, like the commission in `settle.ts`: it is shop-wide,
  // it is cached, and a sweep of fifty services should not ask fifty times.
  const { warnDays, warnVolumeGb, onHoldDays } = await loadShopSettings(db);
  const { results } = await db
    .prepare(
      // Only what is genuinely still running: expired and exhausted services are
      // past warning, and a customer who has been told once is not told again.
      // `notify->>'x' IS DISTINCT FROM 'true'` rather than `= 'false'`, because
      // the key is absent on every row that has never been warned.
      `SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.expires_at,
              s.volume_gb, s.used_bytes, s.purchased_at, 'time' AS reason
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
               s.volume_gb, s.used_bytes, s.purchased_at, 'volume' AS reason
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

        UNION ALL

        -- Bought and never connected.
        --
        -- The legacy asks the panel for accounts in its on_hold status. We do
        -- not carry that status: sync.ts refuses to write the panel's status
        -- onto the row because no honest mapping exists between its five words
        -- and our six. Zero bytes is the same customer seen from our own data,
        -- and it is strictly wider -- a plan sold as active rather than
        -- on_hold is burning days without connecting, which is the case that
        -- needs the nudge most and the one the legacy cannot see.
        --
        -- last_synced_at IS NOT NULL is what makes zero mean zero. A row we
        -- have never synced carries the used_bytes it was sold with, and
        -- nudging on that would tell a customer who connected an hour ago that
        -- they never did.
        --
        -- Mirzabot also skips anyone with a pending change_location request,
        -- so a person already talking to support is not nagged. We have no
        -- location-change flow, so there is nothing to skip -- if one lands,
        -- its exclusion belongs here.
        SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.expires_at,
               s.volume_gb, s.used_bytes, s.purchased_at, 'unused' AS reason
          FROM subscriptions s
          JOIN users u ON u.id = s.user_id
         WHERE s.status = 'ACTIVE'
           AND u.notify_enabled
           AND u.status <> 'BLOCKED'
           AND s.notify->>'unused' IS DISTINCT FROM 'true'
           AND s.last_synced_at IS NOT NULL
           AND s.used_bytes = 0
           AND s.purchased_at <= to_timestamp(?1 / 1000.0) - make_interval(days => ?6)
           -- A service that has already run out is past nudging: telling
           -- somebody to go connect a thing that stopped working is worse than
           -- silence.
           AND (s.expires_at IS NULL OR s.expires_at > to_timestamp(?1 / 1000.0))

         LIMIT ?5`,
    )
    .bind(now, warnDays, warnVolumeGb * 1024 ** 3, 1024 ** 3, BATCH, onHoldDays)
    .all<DueRow>();

  // Asked once, and only when somebody is actually going to be pointed at
  // support. Every other pass pays nothing for it.
  const supportHandle = (results ?? []).some((r) => r.reason === 'unused')
    ? await settingText(db, 'bot', 'id_support')
    : null;

  let warned = 0;

  for (const row of results ?? []) {
    // Claim the warning and record the message in one transaction, guarded on
    // the same condition the SELECT used. Two sweeps overlapping — or one
    // restarted mid-batch — then warn once.
    //
    // The claim used to stand alone and the message was returned to be sent
    // afterwards, which meant a send that failed marked the subscription warned
    // and told nobody. A warning is only useful before the thing runs out, so
    // "lost silently" was the one outcome worth engineering against.
    const claimed = await db.withSession(async (tx) => {
      const marked = await tx
        .prepare(
          `UPDATE subscriptions
              SET notify = notify || jsonb_build_object(?2::text, true),
                  updated_at = now()
            WHERE id = ?1 AND notify->>?2 IS DISTINCT FROM 'true'`,
        )
        .bind(row.id, row.reason)
        .run();
      if (marked.meta.changes === 0) return false;
      if (row.telegram_id === null) return true;

      await enqueue(tx, {
        // Subscription and reason: exactly the pair the claim above is keyed
        // on, so the message cannot be enqueued twice for one warning.
        dedupeKey: `warn:${row.id}:${row.reason}`,
        chatId: row.telegram_id,
        text: messageFor(row, now, supportHandle),
      });
      return true;
    });
    if (claimed) warned += 1;
  }

  return warned;
}

/** Which of the three, worded for the reason the row was picked. */
function messageFor(row: DueRow, now: number, supportHandle: string | null): string {
  switch (row.reason) {
    case 'time':
      return menu.timeRunningOut(row.plan_name_at_sale, daysLeft(row.expires_at, now));
    case 'volume':
      return menu.volumeRunningOut(
        row.plan_name_at_sale,
        (row.volume_gb ?? 0) * 1024 ** 3 - (row.used_bytes ?? 0),
      );
    case 'unused':
      return menu.serviceNeverUsed(
        row.plan_name_at_sale,
        daysSince(row.purchased_at, now),
        supportHandle,
      );
  }
}

/**
 * Whole days since the purchase, rounded DOWN.
 *
 * The opposite of `daysLeft` and for the same reason: this number appears in a
 * sentence that also had to be true for the row to be selected at all. The
 * query says at least `onHoldDays` have passed; rounding up could print a
 * larger number than has actually elapsed, and a customer who bought four days
 * ago being told it was five is the kind of small wrongness that costs a
 * support message.
 */
function daysSince(purchasedAt: string, now: number): number {
  return Math.floor((now - Date.parse(purchasedAt)) / 86_400_000);
}

/** Rounded up, so the last hours of a service read as "1 day" rather than "0". */
function daysLeft(expiresAt: string | null, now: number): number {
  if (expiresAt === null) return 0;
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 86_400_000));
}
