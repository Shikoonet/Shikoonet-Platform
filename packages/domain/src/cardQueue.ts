/**
 * The bakery queue — Sam, 2026-09-15: «هر کی نان گرفت بره انتهای صف».
 *
 * A card handed to an invoice is out of the line while that invoice is open.
 * Nothing records the hold separately: the open `payments` row is the lease,
 * written when the card is shown and closed by PAID, REJECTED or EXPIRED. The
 * fragment below reads it, and both the bot's picker and the dashboard's card
 * list use the same one so they cannot disagree about who is busy.
 *
 * Out of the line for ANY amount — issue #304, 2026-09-18. Until then the
 * picker asked «is this card holding an invoice for MY amount», on the
 * reasoning that only same-amount invoices confuse the matcher. True, and
 * beside the point: the line moves only when money lands, and money lands
 * minutes after the checkout (the relay phone delivered three SMS eleven
 * minutes late that morning), so every customer of a busy quarter-hour was
 * told the same front card — five deposits on one card while five others
 * stood free, and two of them for the same amount, eleven minutes apart. A
 * held card is in somebody's hands; the next customer takes the next one.
 * Same fragment, bot and dashboard both.
 *
 * ONE length, and «I paid» does not stretch it — Sam, 2026-09-17: «ما سقف
 * نداریم اصلا؛ یک زمانی رو مشخص میکنیم، اگر پول اومد که هیچ، اگر نیومد کارت
 * آزاد میشه و اون پیام برای کاربر پاک بشه». `pay/card_hold_minutes` from the
 * moment the card was shown — ten unless the operator changed it (Sam,
 * 2026-09-15: «۵ دقیقه یا ۲ دقیقه یا هر چقدر که دوست داره»). After that the
 * card is back in the line whatever the customer pressed, and the invoice —
 * `order.ts` writes `orders.expires_at` from this same setting (0070) — is
 * closed where the customer sees it (`expire.ts`).
 *
 * Until 2026-09-17 a «پرداخت کردم» press kept the card out for 24 hours or
 * until somebody settled the claim. In production that day six of seven live
 * cards stood behind such holds from claims nobody had reviewed, the
 * dashboard read «در دست مشتری تا» tomorrow on card after card, and the shop
 * sold on the one free card. A claim that has not been settled by the
 * deadline is still a claim — it stays in the review queue and money that
 * arrives late is still matched or approved by hand — but it is not a reason
 * to keep the card away from the next customer. The residual risk is the
 * matcher's own to report: two claims for the same amount on the same card
 * inside one window land in review as AMBIGUOUS, not in the wrong pocket.
 */

export const DEFAULT_CARD_HOLD_MINUTES = 10;
/** The hold at the default setting — what a fresh database gives. */
export const CARD_HOLD_MS = DEFAULT_CARD_HOLD_MINUTES * 60_000;

/**
 * The operator's number, read inside the statement so the bot and the
 * dashboard cannot hold different copies of it. The settings screen saves
 * numbers as JSON strings and 0064 seeds a JSON number; `#>> '{}'` reads both
 * as text. Anything that is not a positive number — a cleared field, a stray
 * minus, a zero — falls back to the default rather than to «no hold»: since
 * this number is also the invoice's lifetime, zero would mean an invoice that
 * is dead the moment it is printed.
 *
 * Exported for `order.ts`, which writes the invoice deadline from it. One
 * fragment, two readers, so the hold and the deadline cannot drift apart.
 */
export const CARD_HOLD_MINUTES_SQL = `COALESCE(
  (SELECT CASE WHEN s.value #>> '{}' ~ '^[1-9][0-9]{0,3}$' THEN (s.value #>> '{}')::int END
     FROM settings s WHERE s.scope = 'pay' AND s.key = 'card_hold_minutes'),
  ${DEFAULT_CARD_HOLD_MINUTES})`;

/**
 * Scalar subquery, correlated on an outer `pc` (a `payment_cards` row): the
 * epoch-ms until which the card is held, or NULL when no invoice holds it.
 * Compare against the caller's own `now` — nothing in here reads the clock.
 */
export const CARD_HELD_UNTIL_SQL = `(
  SELECT MAX((EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint
             + ${CARD_HOLD_MINUTES_SQL} * 60000)
    FROM payments p
   WHERE p.assigned_card_number = pc.card_digits
     AND p.status IN ('PENDING', 'AWAITING_REVIEW'))`;

/**
 * Whose invoices a card is shown on — `financial_accounts.customer_visible`,
 * which 0104 widened from a switch into an audience: 0 nobody (books only),
 * 1 customers, 2 resellers (#474). Two lines, not one: a reseller's invoice
 * draws only from the second, an ordinary one only from the first, and a card
 * is never in both.
 */
export const CUSTOMER_CARDS = 1;
export const RESELLER_CARDS = 2;
export type CardAudience = typeof CUSTOMER_CARDS | typeof RESELLER_CARDS;

/** Which line an order's invoice draws from. The order's kind decides, not the buyer. */
export function cardAudienceFor(orderKind: string): CardAudience {
  return orderKind === 'RESELLER_VOLUME' ? RESELLER_CARDS : CUSTOMER_CARDS;
}

/**
 * Where the outer `pc` stands in the line, 1-based, among every card in
 * service in ITS line — across accounts, but within the audience its account
 * serves. The order is the picker's own last tie-break, `(rotation_cursor, id)`;
 * the hold is not folded in because the dashboard shows it as its own badge
 * beside this one.
 *
 * A card on a books-only account (0) is placed in the customers' line, as it
 * was before 0104 — the only line it could join by being switched on.
 */
export const CARD_QUEUE_POSITION_SQL = `(
  SELECT COUNT(*)::int + 1 FROM payment_cards o
    JOIN financial_accounts ofa ON ofa.id = o.financial_account_id
   WHERE o.status = 'ACTIVE' AND ofa.active = 1 AND ofa.status = 'ACTIVE'
     AND ofa.customer_visible = (
       SELECT CASE WHEN pfa.customer_visible = ${RESELLER_CARDS} THEN ${RESELLER_CARDS}
                   ELSE ${CUSTOMER_CARDS} END
         FROM financial_accounts pfa WHERE pfa.id = pc.financial_account_id)
     AND (o.rotation_cursor, o.id) < (pc.rotation_cursor, pc.id))`;
