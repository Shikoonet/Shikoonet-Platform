/**
 * Who a retention rule reaches, asked once and answered in two places.
 *
 * The bot's sweep selects these rows to message; the dashboard counts them
 * so an operator typing «5» sees «۳۴ نفر» before saving. One predicate, or
 * the screen would promise an audience the sweep does not send to.
 *
 * Parameters, in order: ?1 now in epoch ms · ?2 provider id or NULL · ?3 days
 * before · ?4 days after · ?5 panel admin or NULL. Correlated on `s`
 * (subscriptions) and `u` (users). The admin is the line Sam draws
 * (2026-09-20); the provider row is what rules saved before that used, and
 * a rule may still name it.
 */

import type { D1Database } from '@shikoo/database';

/** The window: from `daysAfter` days past expiry up to `daysBefore` days before it. */
export const RETENTION_AUDIENCE_WHERE = `s.status = 'ACTIVE'
                AND u.notify_enabled
                AND (?2::bigint IS NULL OR s.provider_id = ?2)
                AND (?5::text IS NULL OR s.panel_admin = ?5)
                AND s.expires_at IS NOT NULL
                AND s.expires_at >  to_timestamp(?1 / 1000.0) - make_interval(days => ?4)
                AND s.expires_at <= to_timestamp(?1 / 1000.0) + make_interval(days => ?3)`;

/**
 * «فقط یک سرویس، به‌جز تست» — no OTHER paid service. The same family as
 * `OWNS_PAID_SERVICE_SQL`, minus the row being messaged; imported services
 * carry no order and count, as there.
 */
export const RETENTION_ONLY_SERVICE_WHERE = `NOT EXISTS (
                  SELECT 1 FROM subscriptions s2
                    LEFT JOIN orders o2 ON o2.id = s2.order_id
                   WHERE s2.user_id = s.user_id
                     AND s2.id <> s.id
                     AND s2.status <> 'PENDING_PAYMENT'
                     AND o2.kind IS DISTINCT FROM 'TRIAL')`;

/**
 * Whole days to expiry as the SWEEP counts them, in SQL so the key it writes
 * and the row it selects cannot disagree at a midnight: +N before (the last
 * hours read as 1, as `warn.ts` rounds), −N after (the first hours read as
 * −1). Never 0 — the expiry moment belongs to the «after» side.
 */
export const RETENTION_DAY_INDEX_SQL = `CASE
                  WHEN s.expires_at > to_timestamp(?1 / 1000.0)
                  THEN greatest(1, ceil(extract(epoch FROM s.expires_at - to_timestamp(?1 / 1000.0)) / 86400.0))
                  ELSE -greatest(1, ceil(extract(epoch FROM to_timestamp(?1 / 1000.0) - s.expires_at) / 86400.0))
                END`;

export interface RetentionAudienceQuery {
  providerId: number | null;
  panelAdmin: string | null;
  daysBefore: number;
  daysAfter: number;
  onlyService: boolean;
}

/** The admins the sync has seen on accounts, most populous first — the picker's list. */
export async function retentionPanelAdmins(
  db: D1Database,
): Promise<{ admin: string; accounts: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT panel_admin AS admin, count(*)::int AS accounts
         FROM subscriptions
        WHERE panel_admin IS NOT NULL AND status = 'ACTIVE'
        GROUP BY panel_admin ORDER BY accounts DESC, panel_admin`,
    )
    .all<{ admin: string; accounts: number }>();
  return results ?? [];
}

/** How many people the rule would reach right now. */
export async function retentionAudienceCount(
  db: D1Database,
  q: RetentionAudienceQuery,
  now: number = Date.now(),
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
        WHERE ${RETENTION_AUDIENCE_WHERE}${q.onlyService ? `\n          AND ${RETENTION_ONLY_SERVICE_WHERE}` : ''}`,
    )
    .bind(now, q.providerId, q.daysBefore, q.daysAfter, q.panelAdmin)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
