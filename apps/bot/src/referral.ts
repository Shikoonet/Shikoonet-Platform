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
 * So one rule was live: ten percent of what a referred customer paid for their
 * first purchase went to whoever referred them.
 *
 * **Sam, 2026-09-22, changed the rule.** Two rates now, both editable in the
 * dashboard's settings: `bot/affiliatespercentage` on the referred customer's
 * FIRST purchase (30 from migration 0093), and `bot/affiliatespercentage_renewal`
 * on EVERY renewal they make, of any of their services, as often as they renew
 * (10). An add-on pays nothing («فعلاً نداریم»).
 *
 * **Sam, 2026-09-23:** a second, third, … new purchase pays the renewal rate
 * too — «وقتی تمدید کرد یا اکانت دیگه‌ای خرید، ۱۰٪» — and a purchase that cost
 * nothing (a 100% code) is not the «first purchase»: the first one they PAY
 * for is. The joining gift that credits
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
 * The first-purchase rate when the setting cannot be read.
 *
 * The live rate is `bot/affiliatespercentage` in `settings`, which the
 * migration filled with production's own 10 and nothing read until now. It is
 * passed in rather than looked up here so this file stays free of the database
 * beyond the transaction it is handed, and so a test can state the rate it is
 * asserting instead of importing the constant it is checking.
 */
export const COMMISSION_PERCENT = 30;

/** The renewal rate when the setting cannot be read. */
export const RENEWAL_COMMISSION_PERCENT = 10;

/** The two rates `payReferralCommission` chooses between, by order kind. */
export interface CommissionRates {
  /** Percent of the referred customer's first purchase. */
  first: number;
  /** Percent of each of their renewals, and of every new purchase after the first. */
  renewal: number;
}

export const DEFAULT_COMMISSION_RATES: CommissionRates = {
  first: COMMISSION_PERCENT,
  renewal: RENEWAL_COMMISSION_PERCENT,
};

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
 * Pays the referrer for this order, if it is one that earns a commission.
 *
 * Called from the one place an order becomes real. Everything it needs is read
 * inside the caller's transaction, and the write is guarded by the wallet's
 * unique key, so calling it twice for one order pays once.
 *
 * Which orders earn, and at which rate, is decided by kind alone:
 *
 *   - `RENEWAL` — always, at `rates.renewal`. Every renewal of every service.
 *   - `NEW_PURCHASE` — at `rates.first` when it is the customer's only PAID
 *     new purchase past AWAITING_PAYMENT, this one included; at
 *     `rates.renewal` otherwise. Counted over `NEW_PURCHASE` alone, and only
 *     over ones that cost something: a deposit, a trial, a renewal or a free
 *     purchase before it must not make the first paid purchase look like a
 *     second.
 *   - anything else — a top-up (paying on it would pay again on whatever it
 *     then buys), a trial, an add-on, a transfer — nothing.
 */
export async function payReferralCommission(
  tx: D1DatabaseSession,
  orderId: number,
  rates: CommissionRates = DEFAULT_COMMISSION_RATES,
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
  if (order.total_irr <= 0) return null;

  let percent: number;
  let what: string;
  if (order.kind === 'RENEWAL') {
    percent = rates.renewal;
    what = 'a renewal';
  } else if (order.kind === 'NEW_PURCHASE') {
    const counted = await tx
      .prepare(
        // Only paid NEW_PURCHASE is counted. Until 2026-09-22 this counted
        // every kind but WALLET_TOPUP and TRIAL — and before that TRIAL too,
        // which withheld the commission from every customer who tried first.
        // Until 2026-09-23 a free purchase counted, so a 100% code spent the
        // «first» and the purchase they then paid for earned nothing.
        `SELECT count(*)::int AS n FROM orders
          WHERE user_id = ?1 AND kind = 'NEW_PURCHASE' AND total_irr > 0
            AND status IN ('PAID', 'PROVISIONING', 'COMPLETED')`,
      )
      .bind(order.user_id)
      .first<{ n: number }>();
    const first = (counted?.n ?? 0) <= 1;
    percent = first ? rates.first : rates.renewal;
    what = first ? 'a first purchase' : 'a repeat purchase';
  } else {
    return null;
  }

  // Rounded down: a commission is money leaving, and the half Rial that
  // rounding up would invent has to come from somewhere. A rate of 0 is how
  // the dashboard switches one of the two off.
  const amountIrr = Math.floor((order.total_irr * percent) / 100);
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
      `${percent}% of ${what}`,
      `referral:${order.id}`,
    )
    .run();
  return done.meta.changes > 0 ? amountIrr : null;
}
