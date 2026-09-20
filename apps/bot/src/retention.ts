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
 * ## Once, and the outbox is the record
 *
 * No flag on `subscriptions`. The dedupe key carries the rule, the service
 * and the expiry it was about, and `enqueue` is `ON CONFLICT DO NOTHING` on
 * it — the same claim `nudge.ts` makes. A renewal moves `expires_at`, so the
 * next cycle earns a new key and a new message, which is what a retention
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
  parseRetentionRules,
  renderRetentionText,
  retentionDedupeKey,
  type RetentionRule,
} from '@shikoo/contracts';
import { createLogger } from '@shikoo/domain';
import { enqueue } from './notify.js';
import { report } from './reports.js';
import { loadShopSettings } from './settings.js';
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
  expires_at: string;
  expires_epoch: number;
}

/**
 * Those in the window who have not been told about this expiry.
 *
 * `u.status` is deliberately not consulted, as in `warn.ts`: a paid customer
 * is told about a thing they own. `s.status = 'ACTIVE'` holds after expiry
 * too — nothing but the removal sweep changes it — so «days after» reaches a
 * lapsed service without a second branch.
 */
const DUE = `SELECT s.id, u.telegram_id, s.plan_name_at_sale, s.remote_username,
                    s.expires_at::text AS expires_at,
                    extract(epoch FROM s.expires_at)::bigint AS expires_epoch
               FROM subscriptions s
               JOIN users u ON u.id = s.user_id
              WHERE s.status = 'ACTIVE'
                AND u.notify_enabled
                AND s.provider_id = ?2
                AND s.expires_at IS NOT NULL
                AND s.expires_at >  to_timestamp(?1 / 1000.0) - make_interval(days => ?4)
                AND s.expires_at <= to_timestamp(?1 / 1000.0) + make_interval(days => ?3)
                AND NOT EXISTS (
                  SELECT 1 FROM bot_notifications n
                   WHERE n.dedupe_key = 'retention:' || ?5 || ':' || s.id::text || ':'
                                        || extract(epoch FROM s.expires_at)::bigint::text)`;

/**
 * «فقط یک سرویس، به‌جز تست» — no OTHER paid service. The same family as
 * `OWNS_PAID_SERVICE_SQL`, minus the row being messaged; imported services
 * carry no order and count, as there.
 */
const ONLY_SERVICE = `
                AND NOT EXISTS (
                  SELECT 1 FROM subscriptions s2
                    LEFT JOIN orders o2 ON o2.id = s2.order_id
                   WHERE s2.user_id = s.user_id
                     AND s2.id <> s.id
                     AND s2.status <> 'PENDING_PAYMENT'
                     AND o2.kind IS DISTINCT FROM 'TRIAL')`;

const TAIL = `
              ORDER BY s.expires_at
              LIMIT ?6`;

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

/** The code's text if a customer could use it today, else null. */
async function usableCode(db: D1Database, codeId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT code FROM discount_codes
        WHERE id = ?1 AND status = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_uses IS NULL OR max_uses > (
                SELECT count(*) FROM discount_redemptions r
                  LEFT JOIN orders o ON o.id = r.order_id
                 WHERE r.code_id = discount_codes.id
                   AND (r.order_id IS NULL OR o.status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED'))))`,
    )
    .bind(codeId)
    .first<{ code: string }>();
  return row?.code ?? null;
}

export async function remindToRenew(db: D1Database, now: number = Date.now()): Promise<number> {
  const rules = (await loadRetentionRules(db)).filter((r) => r.enabled);
  if (rules.length === 0) return 0;
  const shop = await loadShopSettings(db);

  let total = 0;
  for (const rule of rules) {
    let code: string | null = null;
    if (rule.codeId !== null) {
      code = await usableCode(db, rule.codeId);
      if (code === null) {
        log.warn('retention.code_unusable', { rule: rule.key, codeId: rule.codeId });
        continue;
      }
    }

    const { results } = await db
      .prepare(DUE + (rule.onlyService ? ONLY_SERVICE : '') + TAIL)
      .bind(now, rule.providerId, rule.daysBefore, rule.daysAfter, rule.key, BATCH)
      .all<DueRow>();

    let sent = 0;
    for (const row of results ?? []) {
      const days = wholeDays(row.expires_at, now);
      const dedupeKey = retentionDedupeKey(rule.key, row.id, Number(row.expires_epoch));
      const queued = await db.withSession(async (tx) => {
        const ok = await enqueue(tx, {
          dedupeKey,
          chatId: row.telegram_id,
          text: renderRetentionText(rule.text, {
            days: String(Math.abs(days)),
            service: withoutQuotedPrice(row.plan_name_at_sale),
            username: row.remote_username ?? '',
            code: code ?? '',
            renewButton: menu.renewButtonLabel(),
          }),
        });
        // «📝 گزارش اطلاع رسانی ها», like every other notice a sweep sends.
        if (ok) {
          await report(
            tx,
            shop,
            'reportcron',
            dedupeKey,
            menu.retentionNotice({
              rule: rule.name,
              config: row.remote_username ?? '',
              days,
              code: code ?? '—',
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

/**
 * Days until expiry: positive before it (rounded up, so the last hours read
 * as «1» not «0», as `warn.ts` does), negative after it (rounded down, so
 * «3 days ago» is not printed before three whole days have passed).
 */
function wholeDays(expiresAt: string, now: number): number {
  const ms = Date.parse(expiresAt) - now;
  return ms >= 0 ? Math.max(1, Math.ceil(ms / 86_400_000)) : -Math.floor(-ms / 86_400_000);
}
