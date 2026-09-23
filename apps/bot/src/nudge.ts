/**
 * One message to somebody who started the bot and never bought anything.
 *
 * The only sweep here whose audience is not a customer. Everything else in the
 * poll loop is about a service somebody paid for; this is about the 11,000-odd
 * people who pressed «شروع» and stopped.
 *
 * ## It is new, and the legacy is the reason to be careful with it
 *
 * No cron does this in any of the three bots we keep. Mirzabot has the same
 * audience — `admin.php:1247`, `nonecustomer` — but as a BUTTON: an admin picks
 * the group and presses send, once, when they mean to. Making it automatic is
 * the change, and it is why the switch defaults off (migration 0057). A shop
 * that upgrades does not start messaging non-customers because we shipped.
 *
 * ## Once, for ever
 *
 * `bot_notifications.dedupe_key` is `nudge:<userId>`, and `enqueue` is an
 * `ON CONFLICT DO NOTHING` on that column. Nothing prunes that table — the same
 * property `warn.ts` relies on — so the row stays as the record that this
 * person has been asked, and a second sweep in a year finds it and stops.
 *
 * That is deliberately not a column on `users`. A flag would be a second place
 * to keep «have we nudged them» in step with the queue that actually sent it,
 * and the two would disagree the first time a send failed.
 *
 * ## Who is excluded, and why each one
 *
 *   notify_enabled false   the customer's own switch, the same one every
 *                          warning respects
 *   any COMPLETED order    they bought. This sweep's whole audience is
 *                          «never bought», and «bought once a year ago» is a
 *                          different message nobody has asked for
 *   blocked users          `status` is consulted here and NOT in `warn.ts`,
 *                          and the difference is the point: a warning goes to
 *                          somebody who paid us and is about a thing they own,
 *                          so a wrong block must not silence it. A marketing
 *                          nudge to somebody the flood guard blocked is just
 *                          the shop shouting at a person it already ejected
 */

import { randomInt } from 'node:crypto';
import type { D1Database } from '@shikoo/database';
import { COMPLETED_A_PURCHASE_SQL, createLogger } from '@shikoo/domain';
import { enqueue } from './notify.js';
import * as menu from './menu.js';
import { loadShopSettings } from './settings.js';

const log = createLogger('bot');

/**
 * A ceiling per pass.
 *
 * Twenty-five, between `warn.ts`'s fifty and `remove.ts`'s ten. These are real
 * sends to people who did not ask, so the first time it is switched on a
 * backlog of eleven thousand drains over days rather than arriving as one
 * burst that gets the bot reported.
 */
const BATCH = 25;

interface DueRow {
  id: number;
  telegram_id: number;
  first_name: string | null;
}

/** No 0/O or 1/I — the customer may type it rather than copy it. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * `TR` and six random characters.
 *
 * Random rather than derived from the user: the code is typed into the same
 * box as every shop code, so a guessable one would only be refused by
 * `target_user_id` — and refusing is `discount.ts`'s job, not a reason to make
 * guessing easy. A clash with an existing code fails the INSERT, which rolls
 * the nudge back with it and the next sweep draws again.
 */
function mintCode(): string {
  let out = 'TR';
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Nudges people who started and never bought, once each.
 *
 * `NOT EXISTS` rather than a LEFT JOIN with a NULL test: the question is
 * «is there any completed order», the index answers it on the first row, and
 * a join would build the whole set to throw it away.
 */
export async function nudgeNeverBought(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const { cron, nudgeAfterDays, nudgeDiscountPercent, nudgeDiscountDays } =
    await loadShopSettings(db);
  // Off is the default. Returned before the query, so a shop that leaves it
  // off pays one cached settings read a cycle.
  if (!cron.nudge_never_bought) return 0;

  const { results } = await db
    .prepare(
      `SELECT u.id, u.telegram_id, u.first_name
         FROM users u
        WHERE u.telegram_id IS NOT NULL
          AND u.notify_enabled
          AND u.status = 'ACTIVE'
          AND u.registered_at <= to_timestamp(?1 / 1000.0) - make_interval(days => ?2)
          AND NOT ${COMPLETED_A_PURCHASE_SQL}
          -- The record that they have already been asked. Checked in the
          -- SELECT as well as relied on at the INSERT: without it every sweep
          -- would re-read the same eleven thousand rows for ever, fill its
          -- batch with people who were nudged months ago, and never reach
          -- anybody new.
          AND NOT EXISTS (
            SELECT 1 FROM bot_notifications n
             WHERE n.dedupe_key = 'nudge:' || u.id::text)
        ORDER BY u.registered_at
        LIMIT ?3`,
    )
    .bind(now, nudgeAfterDays, BATCH)
    .all<DueRow>();

  let sent = 0;
  for (const row of results ?? []) {
    const code = nudgeDiscountPercent > 0 ? mintCode() : null;
    // The insert is the claim. Two overlapping sweeps both reaching this line
    // for one person cannot both write the row, and the loser gets `false`.
    // The code is written in the same transaction and only by the winner, so
    // no message names a code that does not exist and no code exists that
    // nobody was sent.
    const queued = await db.withSession(async (tx) => {
      const ok = await enqueue(tx, {
        dedupeKey: `nudge:${row.id}`,
        chatId: row.telegram_id,
        text: code
          ? menu.neverBoughtNudgeWithCode(
              row.first_name,
              nudgeDiscountPercent,
              code,
              nudgeDiscountDays,
            )
          : menu.neverBoughtNudge(),
      });
      if (ok && code) {
        // Everything the offer promises is a column `checkCode` already
        // enforces: this customer only, once, a first purchase, until the
        // deadline. A trial is not a purchase there either (`bought.ts`).
        await tx
          .prepare(
            `INSERT INTO discount_codes
               (code, kind, percent, max_uses, uses_per_user, first_purchase_only,
                applies_to, target_user_id, expires_at)
             VALUES (?1, 'PERCENT_OFF', ?2, 1, 1, true, 'BUY', ?3,
                     to_timestamp(?4 / 1000.0) + make_interval(days => ?5))`,
          )
          .bind(code, nudgeDiscountPercent, row.id, now, nudgeDiscountDays)
          .run();
      }
      return ok;
    });
    if (queued) sent += 1;
  }

  if (sent > 0) log.info('sweep.acted', { job: 'nudge_never_bought', count: sent });
  return sent;
}
