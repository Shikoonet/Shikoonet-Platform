/**
 * Closing an invoice nobody paid.
 *
 * `orders.expires_at` and `idx_orders_open` — a partial index over exactly this
 * query — have been in the schema since `0003_sales.sql` and nothing has ever
 * written the column or read the index. The invoice simply stayed open.
 *
 * What that costs is not the row. It is the message: a card-to-card invoice
 * names a specific card, and that card sits in the customer's chat history for
 * as long as the invoice is open. Cards are rotated, disabled, and eventually
 * removed — `payments.assigned_card_number` is denormalised text precisely
 * because 22 production leases already point at cards that no longer exist. A
 * customer who scrolls up next week and pays the invoice they find sends money
 * to an account that may not be ours any more, and no transaction we can match
 * will ever arrive.
 *
 * The window was the legacy bot's twenty-four hours (`cronbot/payment_expire.php`,
 * `time() - 86400`) until 2026-09-17. It is the CARD HOLD now —
 * `pay/card_hold_minutes`, ten by default — because the card is handed to the
 * next customer when the hold ends, and an invoice that stays valid after that
 * names a card that is no longer its own. `order.ts` writes the deadline;
 * migration 0070 says what the gap between the two clocks cost.
 *
 * The legacy sweep deletes the stale invoice message and — the line is there,
 * commented out — says nothing. We turn the invoice itself into the notice:
 * the message the customer is looking at becomes «مهلت تمام شد», its buttons
 * go with it, and the card number stops standing in the chat. When the bot
 * never learned which message the invoice is (`payments.invoice_message_id`
 * is null — a send whose id Telegram did not give back), or Telegram refuses
 * the edit, the customer gets a new message instead. Deleting a message about
 * their own money without a word is how a customer concludes the bot lost
 * their order; saying nothing at all is worse.
 */

import type { D1Database } from '@shikoo/database';
import * as menu from './menu.js';
import { enqueue } from './notify.js';

/*
 * The deadline is NOT here.
 *
 * It was `ORDER_TTL_MS = 24h` here, then `settings.order_ttl_hours`, and is now
 * `pay/card_hold_minutes` — always read in `order.ts` at the moment an invoice
 * is written, which is where the deadline is decided. This sweep reads
 * `orders.expires_at` and always did; it never needed to know the length, only
 * that the column had passed.
 */

/** A ceiling per pass, like every other sweep here. */
const BATCH = 100;

interface ExpiredRow {
  id: number;
  public_id: string;
  /**
   * Not nullable: the column is `NOT NULL` since 0001 and the RETURNING reads it
   * through an inner join, so «no chat id» is a state this query cannot produce.
   * The branch that used to skip on null went with the type.
   */
  telegram_id: number;
}

/** The checkout that went with the order, and the message it was drawn on. */
interface ExpiredPayment {
  order_id: number;
  invoice_message_id: number | null;
}

/**
 * Expires the invoices whose day has run out, and tells whoever they belonged to.
 *
 * ## Why this is two statements and a lock
 *
 * An order may only expire while nobody claims to have paid it. Getting that
 * wrong is the worst failure this file could have: an order marked EXPIRED with
 * a live claim against it is money that arrives, verifies, and settles onto an
 * order `settle.ts` will not advance — because it guards on `AWAITING_PAYMENT`
 * — leaving a customer who paid, an admin who approved, and no service.
 *
 * "Nobody claims to have paid" cannot be asked in the same statement that does
 * the expiring. A condition on `payments` inside this UPDATE is evaluated
 * against the snapshot the statement started with, and a blocked write re-checks
 * only the row it locked, never the tables joined to it. So the candidates are
 * locked first, in their own statement; the second statement then runs with a
 * fresh snapshot that sees every «پرداخت کردم» committed before the lock, and
 * every one arriving after it waits on the lock and finds the order gone.
 *
 * `SKIP LOCKED` is the other half: an order being paid for at this instant is
 * held by that transaction, so it is passed over rather than queued behind. It
 * is still expiring, and it will still be here next cycle if it goes unpaid.
 */
export async function expireUnpaidOrders(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const rows = await db.withSession(async (tx) => {
    const { results: doomed } = await tx
      .prepare(
        `SELECT id FROM orders
          WHERE status = 'AWAITING_PAYMENT'
            AND expires_at IS NOT NULL
            AND expires_at <= to_timestamp(?1 / 1000.0)
          ORDER BY expires_at
          LIMIT ?2
          FOR UPDATE SKIP LOCKED`,
      )
      .bind(now, BATCH)
      .all<{ id: number }>();
    const ids = (doomed ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const { results: expired } = await tx
      .prepare(
        `UPDATE orders o
            SET status = 'EXPIRED', updated_at = now()
           FROM users u
          WHERE o.user_id = u.id
            AND o.id = ANY(?1)
            -- Redundant today and kept anyway, and said plainly rather than
            -- claimed: the query above already filtered on this status and
            -- holds a lock on every row it returned, so nothing this suite can
            -- construct makes this condition decide anything — removing it
            -- leaves every test green. What it guards is the seam between the
            -- two statements, which is a lock acquisition and therefore a
            -- newer snapshot. Reasoned, not demonstrated.
            AND o.status = 'AWAITING_PAYMENT'
            AND NOT EXISTS (
              SELECT 1 FROM payments p
               WHERE p.order_id = o.id
                 AND p.status IN ('AWAITING_REVIEW', 'PROCESSING', 'PAID'))
        RETURNING o.id, o.public_id, u.telegram_id`,
      )
      .bind(ids)
      .all<ExpiredRow>();
    if ((expired ?? []).length === 0) return [];

    // The checkout attempt goes with the order it was for. Left PENDING it
    // keeps the card attached to a dead invoice, and `checkoutFor` would hand
    // that same stale card back if the order were ever reopened.
    //
    // Bound to the orders that actually expired, not to the candidates we
    // locked. The two sets differ by the orders somebody has claimed to have
    // paid, and unreachably so today: a claimed order's payment row is
    // AWAITING_REVIEW, which `status = 'PENDING'` already excludes, and
    // `checkoutFor` reuses the single live row rather than adding a second.
    // Said rather than demonstrated, because a test for it would have to build
    // a state this code cannot produce. What it costs to be right is one
    // column in the RETURNING, and what it buys is that the statement means
    // what the sentence above it says — so the day a second payment row
    // becomes possible, this does not quietly kill a live checkout.
    const { results: closed } = await tx
      .prepare(
        `UPDATE payments SET status = 'EXPIRED', updated_at = now()
          WHERE order_id = ANY(?1) AND status = 'PENDING'
        RETURNING order_id, invoice_message_id`,
      )
      .bind((expired ?? []).map((r) => r.id))
      .all<ExpiredPayment>();
    const invoiceMessageOf = new Map(
      (closed ?? []).map((p) => [p.order_id, p.invoice_message_id] as const),
    );

    // The shelf row the invoice was holding goes back on the shelf (0063).
    // Same transaction as the expiry: an invoice cannot die while still
    // owning an account nobody else may buy.
    await tx
      .prepare(
        `UPDATE provisioning_stock SET status = 'AVAILABLE', order_id = NULL
          WHERE order_id = ANY(?1) AND status = 'RESERVED'`,
      )
      .bind((expired ?? []).map((r) => r.id))
      .run();

    // Same transaction as the expiry itself, so an order can never be marked
    // EXPIRED without the customer being owed the news. Written INTO the
    // invoice when its message is known — no keyboard, so «پرداخت کردم» and
    // the copy buttons go with the card number.
    for (const row of expired ?? []) {
      await enqueue(tx, {
        dedupeKey: `expire:${row.public_id}`,
        chatId: row.telegram_id,
        text: menu.orderExpired(row.public_id),
        editMessageId: invoiceMessageOf.get(row.id) ?? null,
      });
    }

    return expired ?? [];
  });

  return rows.length;
}
