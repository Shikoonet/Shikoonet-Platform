/**
 * Bringing someone else to the bot.
 *
 * What is actually switched on in production, read out of the `affiliates` row
 * and the `setting` row on the 2026-08-11 dump rather than assumed:
 *
 *     status_commission  oncommission          commission is on
 *     porsant_one_buy    on_buy_porsant        ...on the FIRST purchase only
 *     affiliatespercentage  10                 ...at 10 percent
 *     Discount           offDiscountaffiliates the joining gift is OFF
 *     scorestatus        0                     the points system is OFF
 *
 * So one rule is live: **ten percent of what a referred customer pays for their
 * first purchase goes to whoever referred them.** The joining gift that credits
 * both sides half of `price_Discount` is switched off, so it is not built —
 * building a disabled feature is how you get a second, untested money path.
 *
 * `function.php:944-956` is the payout, and it does it by `UPDATE user SET
 * Balance = Balance + x`. Here it is a `wallet_entries` row like every other
 * movement, with `idempotency_key = referral:<orderId>`: the sweep can run
 * twice, the customer can pay twice, and the referrer is still paid once —
 * decided by a UNIQUE index rather than by a flag this code reads first.
 *
 * The PHP's own version of that guarantee is a race: `index.php:5928` writes
 * `get_gift = true` and THEN tests the value it read before writing, so two
 * taps arriving together both see false and both credit.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/**
 * ponytail: the rate lives here, not in `settings`, for the same reason the
 * top-up limits do — nothing can edit it yet, so a deploy is the only way it
 * changes either way. `settings` already carries the migrated value under
 * `bot/affiliatespercentage`; read it here the day an admin screen can write it.
 */
export const COMMISSION_PERCENT = 10;

/** `t.me/<bot>?start=<userId>` — the payload is the referrer's own row id. */
export function referralLink(botUsername: string, userId: number): string {
  return `https://t.me/${botUsername}?start=${userId}`;
}

/**
 * Reads a `/start` payload as a referrer id.
 *
 * Untrusted: it is whatever followed `/start` in a message anyone can send. It
 * is only ever used as a row id to look up, and `claimReferrer` refuses it if
 * it does not resolve to a real, different customer.
 */
export function referrerFromPayload(payload: string | undefined): number | null {
  if (payload === undefined) return null;
  if (!/^[1-9][0-9]{0,18}$/.test(payload)) return null;
  const id = Number(payload);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Records who brought this customer, if nobody has yet.
 *
 * The `IS NULL` in the WHERE is the rule: the first link wins and a customer
 * cannot be re-attributed later, which is what stops a second `/start` from a
 * different link moving the commission. Self-referral is refused in SQL too,
 * so a customer cannot pay themselves.
 */
export async function claimReferrer(
  tx: D1DatabaseSession,
  userId: number,
  referrerId: number,
): Promise<boolean> {
  const done = await tx
    .prepare(
      `UPDATE users SET referred_by = ?2, updated_at = now()
        WHERE id = ?1
          AND referred_by IS NULL
          AND ?1 <> ?2
          AND EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
    )
    .bind(userId, referrerId)
    .run();
  return done.meta.changes > 0;
}

export interface ReferralSummary {
  /** How many customers name this one as their referrer. */
  invited: number;
  /** What their purchases have paid this customer, in IRR. */
  earnedIrr: number;
}

export async function referralSummary(db: Db, userId: number): Promise<ReferralSummary> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*)::int FROM users WHERE referred_by = ?1) AS invited,
              (SELECT coalesce(sum(amount_irr), 0)::bigint FROM wallet_entries
                WHERE user_id = ?1 AND kind = 'REFERRAL_BONUS') AS earned`,
    )
    .bind(userId)
    .first<{ invited: number; earned: number }>();
  return { invited: row?.invited ?? 0, earnedIrr: Number(row?.earned ?? 0) };
}

/**
 * Pays the referrer, if this order is the referred customer's first purchase.
 *
 * Called from the one place an order becomes real. Everything it needs is read
 * inside the caller's transaction, and the write is guarded by the wallet's
 * unique key, so calling it twice for one order pays once.
 *
 * "First purchase" is counted the way `function.php:939` counts it: the
 * customer's orders that are past AWAITING_PAYMENT, this one included. A
 * deposit is not a purchase and is excluded — paying commission on a wallet
 * top-up would pay it again on whatever the top-up then buys.
 */
export async function payReferralCommission(
  tx: D1DatabaseSession,
  orderId: number,
): Promise<number | null> {
  const order = await tx
    .prepare(
      `SELECT o.id, o.user_id, o.total_irr, o.kind, u.referred_by
         FROM orders o JOIN users u ON u.id = o.user_id
        WHERE o.id = ?1`,
    )
    .bind(orderId)
    .first<{
      id: number;
      user_id: number;
      total_irr: number;
      kind: string;
      referred_by: number | null;
    }>();
  if (!order || order.referred_by === null) return null;
  if (order.kind === 'WALLET_TOPUP') return null;
  if (order.total_irr <= 0) return null;

  const counted = await tx
    .prepare(
      `SELECT count(*)::int AS n FROM orders
        WHERE user_id = ?1 AND kind <> 'WALLET_TOPUP'
          AND status IN ('PAID', 'PROVISIONING', 'COMPLETED')`,
    )
    .bind(order.user_id)
    .first<{ n: number }>();
  if ((counted?.n ?? 0) > 1) return null;

  // Rounded down: a commission is money leaving, and the half Rial that
  // rounding up would invent has to come from somewhere.
  const amountIrr = Math.floor((order.total_irr * COMMISSION_PERCENT) / 100);
  if (amountIrr <= 0) return null;

  const done = await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, note, idempotency_key)
       VALUES (?1, ?2, 'REFERRAL_BONUS', ?3, ?4, ?5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      order.referred_by,
      amountIrr,
      order.id,
      `${COMMISSION_PERCENT}% of a first purchase`,
      `referral:${order.id}`,
    )
    .run();
  return done.meta.changes > 0 ? amountIrr : null;
}
