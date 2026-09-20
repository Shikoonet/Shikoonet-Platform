/**
 * «یادآوری تمدید» — the operator's own message to a customer about to leave.
 *
 * `warn.ts` tells every customer their service is ending. This one is
 * narrower and it is the operator's: a rule names a panel, a window around
 * expiry, «only one service», a discount code and a text — and this sweep
 * sends it, once per service per expiry. The rules are read from
 * `settings ('bot','retention_rules')` every cycle; the shape is checked by
 * the same `parseRetentionRules` the panel refused the body with.
 *
 * ## Once a day, and the outbox is the record
 *
 * No flag on `subscriptions`. The dedupe key carries the rule, the service,
 * the expiry it was about and the DAY of the window (+3, −2), and `enqueue`
 * is `ON CONFLICT DO NOTHING` on it — the same claim `nudge.ts` makes. The
 * day part moves once every 24 hours, so a five-day window is five messages
 * a day apart and not one every 25 seconds (Sam, 2026-09-20: «روزی یک بار»);
 * past the window the SELECT stops finding the row. A renewal moves
 * `expires_at`, so the next cycle earns a new key, which is what a retention
 * rule should do for a customer who stayed and is now nearing the end again.
 *
 * ## A code that cannot be used is a rule that does not fire
 *
 * The rule prints `{code}`. A code that is disabled, expired or used up would
 * print a word the bot then refuses at checkout — worse than silence. So the
 * code is checked once per sweep and the rule is skipped, loudly, until the
 * operator fixes it on «کدهای تخفیف».
 */

import type { D1Database } from '@shikoo/database';
import {
  RETENTION_RULES,
  discountLabel,
  parseRetentionRules,
  renderRetentionText,
  type RetentionRule,
} from '@shikoo/contracts';
import {
  RETENTION_AUDIENCE_WHERE,
  RETENTION_DAY_INDEX_SQL,
  RETENTION_ONLY_SERVICE_WHERE,
  createLogger,
  tehranDayFromUtc,
} from '@shikoo/domain';
import { enqueue } from './notify.js';
import { report } from './reports.js';
import { loadShopSettings, settingText } from './settings.js';
import * as menu from './menu.js';
import { withoutQuotedPrice } from './money.js';

const log = createLogger('bot');

/** Per rule per pass. The same ceiling as `warn.ts`, for the same reason. */
const BATCH = 50;

interface DueRow {
  id: number;
  telegram_id: number;
  plan_name_at_sale: string;
  remote_username: string | null;
  /** +N days before expiry, −N after. Computed in SQL beside the key. */
  day_index: number;
  /** The outbox key for this row TODAY, built by the same SQL that selected it. */
  dedupe_key: string;
}

/**
 * Those in the window who have not been written to TODAY about this expiry.
 *
 * The window and «only one service» are `@shikoo/domain`'s, shared with the
 * dashboard's count. The key is built here in SQL and returned rather than
 * recomputed in TypeScript, so the row selected and the row claimed are the
 * same row at every midnight. `u.status` is deliberately not consulted, as
 * in `warn.ts`: a paid customer is told about a thing they own.
 */
const DUE = `SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.remote_username,
                    (${RETENTION_DAY_INDEX_SQL})::int AS day_index,
                    'retention:' || ?6 || ':' || s.id::text || ':'
                      || extract(epoch FROM s.expires_at)::bigint::text || ':'
                      || (${RETENTION_DAY_INDEX_SQL})::int::text AS dedupe_key
               FROM subscriptions s
               JOIN users u ON u.id = s.user_id
              WHERE ${RETENTION_AUDIENCE_WHERE}`;

const ONLY_SERVICE = `
                AND ${RETENTION_ONLY_SERVICE_WHERE}`;

const TAIL = `
                AND NOT EXISTS (
                  SELECT 1 FROM bot_notifications n
                   WHERE n.dedupe_key = 'retention:' || ?6 || ':' || s.id::text || ':'
                                        || extract(epoch FROM s.expires_at)::bigint::text || ':'
                                        || (${RETENTION_DAY_INDEX_SQL})::int::text)
              ORDER BY s.expires_at
              LIMIT ?7`;

export async function loadRetentionRules(db: D1Database): Promise<RetentionRule[]> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(RETENTION_RULES.scope, RETENTION_RULES.key)
    .first<{ value: unknown }>();
  if (!row) return [];
  const rules = parseRetentionRules(row.value);
  if (rules === null) {
    // The panel cannot write this; a hand edit or an older screen can. Said
    // once per cycle rather than half-obeyed.
    log.warn('retention.rules_unreadable', {});
    return [];
  }
  return rules;
}

/** The code and its offer in words, if a customer could use it today; else null. */
async function usableCode(
  db: D1Database,
  codeId: number,
): Promise<{ code: string; discount: string } | null> {
  const row = await db
    .prepare(
      `SELECT code, kind, percent, amount_irr, bonus_gb FROM discount_codes
        WHERE id = ?1 AND status = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_uses IS NULL OR max_uses > (
                SELECT count(*) FROM discount_redemptions r
                  LEFT JOIN orders o ON o.id = r.order_id
                 WHERE r.code_id = discount_codes.id
                   AND (r.order_id IS NULL OR o.status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED'))))`,
    )
    .bind(codeId)
    .first<{ code: string; kind: string; percent: number | null; amount_irr: number | null; bonus_gb: number | null }>();
  if (!row) return null;
  return {
    code: row.code,
    discount: discountLabel({ kind: row.kind, percent: row.percent, amountIrr: row.amount_irr, bonusGb: row.bonus_gb }),
  };
}

/**
 * Today's send slot for a rule with a clock time — Tehran midnight plus
 * «HH:MM» — or `now` itself for a rule without one.
 *
 * The slot, not `now`, is the instant the window and the day index are read
 * at (`?1` below): the same instant all day, so the key is the same all day
 * and a service that enters the window after the slot is not due until
 * tomorrow's. A rule without a time keeps reading at `now`, which is the
 * every-24-hours behaviour it always had.
 */
export function retentionSlot(rule: Pick<RetentionRule, 'sendAt'>, now: number): number {
  if (rule.sendAt === null) return now;
  const [hh, mm] = rule.sendAt.split(':').map(Number);
  return tehranDayFromUtc(now).start + (hh! * 60 + mm!) * 60_000;
}

export async function remindToRenew(db: D1Database, now: number = Date.now()): Promise<number> {
  const rules = (await loadRetentionRules(db)).filter((r) => r.enabled);
  if (rules.length === 0) return 0;
  const shop = await loadShopSettings(db);
  // The bot's own handle, for the deep link under every message — the same
  // row the referral link reads. Without it there is no link to press, so
  // the sweep says so once and sends nothing: a retention message whose
  // button does nothing is worse than no message.
  const botUsername = await settingText(db, 'bot', 'username');
  if (botUsername === null) {
    log.warn('retention.no_bot_username', {});
    return 0;
  }

  let total = 0;
  for (const rule of rules) {
    // Not yet the rule's minute today: nothing, and nothing logged — this
    // is the normal state for most of every day.
    const slot = retentionSlot(rule, now);
    if (now < slot) continue;
    let code: { code: string; discount: string } | null = null;
    if (rule.codeId !== null) {
      code = await usableCode(db, rule.codeId);
      if (code === null) {
        log.warn('retention.code_unusable', { rule: rule.key, codeId: rule.codeId });
        continue;
      }
    }

    const { results } = await db
      .prepare(DUE + (rule.onlyService ? ONLY_SERVICE : '') + TAIL)
      .bind(slot, rule.providerId, rule.daysBefore, rule.daysAfter, rule.panelAdmin, rule.key, BATCH)
      .all<DueRow>();

    let sent = 0;
    for (const row of results ?? []) {
      const days = Number(row.day_index);
      // After expiry the rule's own «after» text, when it wrote one; the
      // «before» text otherwise, which is what every rule from before the
      // field existed has.
      const template = days < 0 && rule.textAfter !== '' ? rule.textAfter : rule.text;
      const queued = await db.withSession(async (tx) => {
        const ok = await enqueue(tx, {
          dedupeKey: row.dedupe_key,
          chatId: row.telegram_id,
          text: renderRetentionText(template, {
            days: String(Math.abs(days)),
            service: withoutQuotedPrice(row.plan_name_at_sale),
            username: row.remote_username ?? '',
            // Tap-to-copy, like the card number on an invoice (#322). Only the
            // bot's own `<code>` passes `toTelegramHtml`; the operator's text
            // around it is escaped like any other, so nothing they type can
            // open a tag.
            code: code === null ? '' : `<code>${code.code}</code>`,
            discount: code?.discount ?? '',
            renewButton: menu.renewButtonLabel(),
          }),
          // One green button, and it is a LINK, not a callback. Sam,
          // 2026-09-20: pressing it must open the bot and start it — a
          // callback only works inside a chat the customer already has open,
          // and the customer this message is for may have closed it weeks ago.
          // `/start rnw_<id>` lands on this service's renewal screen through
          // `handleCallback`, so ownership and every other guard are a real
          // press's. `success` is Telegram's green (Bot API 9.4); an old client
          // draws its default and the label is the same.
          keyboard: [[renewLink(botUsername, row.id)]],
        });
        // «📝 گزارش اطلاع رسانی ها», like every other notice a sweep sends.
        if (ok) {
          await report(
            tx,
            shop,
            'reportcron',
            row.dedupe_key,
            menu.retentionNotice({
              rule: rule.name,
              config: row.remote_username ?? '',
              days,
              code: code?.code ?? '—',
            }),
          );
        }
        return ok;
      });
      if (queued) sent += 1;
    }
    if (sent > 0) log.info('sweep.acted', { job: `retention:${rule.key}`, count: sent });
    total += sent;
  }
  return total;
}

/** «تمدید سرویس», green, opening the bot on this service's renewal. */
export function renewLink(botUsername: string, subscriptionId: number) {
  return {
    text: menu.renewButtonLabel(),
    url: `https://t.me/${botUsername}?start=rnw_${subscriptionId}`,
    style: 'success' as const,
  };
}
