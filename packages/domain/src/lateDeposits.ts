/**
 * A deposit that arrived for an invoice that had already expired.
 *
 * Since #274 an invoice expires with the card hold, and «پرداخت کردم» after
 * that opens no claim, so a customer who pays late lands in «واریزی‌ها» with
 * nobody told. 1 Mehr 1405, production: @m1599p paid 120,000 at 11:08 for an
 * invoice issued at 10:42, then raised eight more 120,000 invoices through
 * the day, all expired, while the deposit sat unclaimed until the evening.
 *
 * Two things live here:
 *
 *   - `loadExpiredInvoiceHints` — «probably invoice X» on a deposit (#275),
 *     moved from the payments hub routes so the alert below reads the same
 *     guess the operator is shown.
 *   - `alertLateDeposits` — tells the report group, once per deposit, and
 *     says what to press. Sam, 1 Mehr: an alert only, no automatic credit —
 *     a customer who already raised a fresh invoice for the same money has to
 *     be matched to that one, not paid twice into the wallet.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { reportTopicKey } from '@shikoo/contracts';
import { INCOME_QUEUE_TX_WHERE } from './incomeEligibility.js';
import { handCreditSince, type HandCredit } from './creditDepositToWallet.js';

type Db = D1Database | D1DatabaseSession;

/** How late a deposit may arrive and still be read as «that invoice». */
export const EXPIRED_INVOICE_HINT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ExpiredInvoiceHint {
  publicId: string;
  /** Epoch ms the invoice was issued. */
  invoiceAt: number;
  customer: { id: number; telegramId: string; username: string | null } | null;
  /** Other expired invoices that fit the same deposit — 0 when this one is alone. */
  others: number;
}

/**
 * «Probably invoice X» on a deposit nobody claimed (#275).
 *
 * An EXPIRED card-to-card invoice for the same amount, on a card mapped to
 * the account the SMS came in on, issued in the 24 hours before the bank
 * stamped the deposit.
 *
 * Only an invoice whose ORDER expired. A card checkout also closes as
 * `EXPIRED` when the customer pays the order from their balance instead
 * (`handle.ts`, the wallet button) — the order is PAID and nobody is late
 * with anything, yet the row looked exactly like an unpaid invoice and was
 * named against a stranger's deposit of the same amount on the same account
 * (#339). The order's status is what says the money is still owed.
 *
 * A hint and nothing more. It is not a match, it verifies nothing, and the
 * rule «auto-verify only for an isolated 1↔1 pair in the five-minute window»
 * is untouched. The newest fitting invoice is named; `others` says how many
 * more fit, so a regular's third attempt is not presented as certain.
 */
export async function loadExpiredInvoiceHints(db: Db, txIds: string[]): Promise<Map<string, ExpiredInvoiceHint>> {
  const out = new Map<string, ExpiredInvoiceHint>();
  if (txIds.length === 0) return out;
  const rows = await db
    .prepare(
      `SELECT DISTINCT ON (t.id)
              t.id AS tx_id,
              p.public_id,
              (EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS invoice_at,
              u.id AS user_id, u.telegram_id, u.username,
              COUNT(*) OVER (PARTITION BY t.id) AS fitting
         FROM transaction_candidates t
         JOIN payments p
           ON p.status = 'EXPIRED'
          AND p.method = 'CARD_TO_CARD'
          AND p.amount_irr = t.amount_irr
          AND p.created_at >  to_timestamp((t.bank_timestamp - ?2) / 1000.0)
          AND p.created_at <= to_timestamp(t.bank_timestamp / 1000.0)
         JOIN payment_cards pc
           ON pc.card_digits = p.assigned_card_number
          AND pc.financial_account_id = t.financial_account_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE t.id = ANY(?1)
          AND t.bank_timestamp IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o
                           WHERE o.id = p.order_id AND o.status <> 'EXPIRED')
        ORDER BY t.id, p.created_at DESC`,
    )
    .bind(txIds, EXPIRED_INVOICE_HINT_WINDOW_MS)
    .all<{
      tx_id: string;
      public_id: string;
      invoice_at: number;
      user_id: number | null;
      telegram_id: number | string | null;
      username: string | null;
      fitting: number;
    }>();
  for (const r of rows.results ?? []) {
    out.set(r.tx_id, {
      publicId: r.public_id,
      invoiceAt: Number(r.invoice_at),
      customer:
        r.user_id != null && r.telegram_id != null
          ? { id: Number(r.user_id), telegramId: String(r.telegram_id), username: r.username }
          : null,
      others: Math.max(0, Number(r.fitting) - 1),
    });
  }
  return out;
}

/** Only deposits this recent are announced — the first run after a deploy must not replay a week. */
export const LATE_DEPOSIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** One alert per deposit, ever: the key is the deposit. */
export function lateDepositDedupeKey(txId: string): string {
  return `report:paymentreport:late-deposit:${txId}`;
}

const FA_NUMBER = new Intl.NumberFormat('fa-IR');
const FA_WHEN = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Tell the report group about every deposit in «واریزی‌ها» that names an
 * expired invoice and has not been announced. Returns how many were queued.
 *
 * Idempotent by the outbox's own `dedupe_key UNIQUE`, so it can run on every
 * sweep. Plain text, no markup: a username with `_` needs no escaping.
 */
export async function alertLateDeposits(db: Db, nowMs: number): Promise<number> {
  const candidates = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, fa.display_name
         FROM transaction_candidates t
         JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE ${INCOME_QUEUE_TX_WHERE}
          AND t.bank_timestamp > ?1
          AND NOT EXISTS (SELECT 1 FROM bot_notifications bn
                           WHERE bn.dedupe_key = 'report:paymentreport:late-deposit:' || t.id)`,
    )
    .bind(nowMs - LATE_DEPOSIT_LOOKBACK_MS)
    .all<{ id: string; amount_irr: string | number; bank_timestamp: string | number; display_name: string }>();
  const txs = candidates.results ?? [];
  if (txs.length === 0) return 0;
  const hints = await loadExpiredInvoiceHints(
    db,
    txs.map((t) => t.id),
  );
  if (hints.size === 0) return 0;

  // No report group, nowhere to say it; the deposit is still in «واریزی‌ها».
  const target = await paymentReportTarget(db);
  if (!target) return 0;

  let queued = 0;
  for (const t of txs) {
    const hint = hints.get(t.id);
    if (!hint) continue;
    const amountIrr = Number(t.amount_irr);
    // A fresh invoice for the same money, raised after the expired one: the
    // late deposit is most likely its payment, and the wallet is the wrong door.
    const open =
      hint.customer === null
        ? null
        : await db
            .prepare(
              `SELECT public_id, status FROM payments
                WHERE user_id = ?1 AND amount_irr = ?2 AND status IN ('PENDING','AWAITING_REVIEW')
                  AND created_at > to_timestamp(?3 / 1000.0)
                ORDER BY created_at DESC LIMIT 1`,
            )
            .bind(hint.customer.id, amountIrr, hint.invoiceAt)
            .first<{ public_id: string; status: string }>();
    // Credited by hand since the deposit came in: then «شارژ کیف پول» would
    // pay the same money a second time, so the message says so instead.
    const hand = hint.customer === null ? null : await handCreditSince(db, hint.customer.id, Number(t.bank_timestamp));
    const who = hint.customer ? (hint.customer.username ? `@${hint.customer.username}` : hint.customer.telegramId) : 'نامعلوم';
    // Toman rounded down, as «واریزی‌ها» shows it (`loadIncomeItems`), so the
    // operator finds the same number on the row this message sends them to.
    const lines = [
      '💸 پول بعد از منقضی شدن فاکتور رسید',
      `${toman(amountIrr)} تومان — ${t.display_name}، ${FA_WHEN.format(Number(t.bank_timestamp))}`,
      `فاکتور ${hint.publicId} (منقضی، ${FA_WHEN.format(hint.invoiceAt)}) — مشتری ${who}`,
      ...(hint.others > 0 ? [`${FA_NUMBER.format(hint.others)} فاکتور منقضی دیگر هم با همین مبلغ هست.`] : []),
      hand
        ? handCreditLine(hand)
        : open
          ? `این مشتری فاکتور باز ${open.public_id} با همین مبلغ دارد${open.status === 'AWAITING_REVIEW' ? ' (رسیدش در انتظار بررسی است)' : ''}: اگر همین پول است، در «پرداخت‌ها › واریزی‌ها» آن را به همان سفارش «تخصیص» کن.`
          : 'در «پرداخت‌ها › واریزی‌ها» روی این واریزی «شارژ کیف پول» بزن تا پولش به کیف پول مشتری برود.',
    ];
    queued += await queuePaymentReport(db, target, lateDepositDedupeKey(t.id), lines);
  }
  return queued;
}

/** One alert per deposit the bot held back. */
export function handCreditedDedupeKey(txId: string): string {
  return `report:paymentreport:hand-credited:${txId}`;
}

/**
 * The wrong-amount sweep (`apps/bot/src/wrongAmount.ts`) found its deposit's
 * customer credited by hand since the deposit came in, and left the deposit
 * where it is. Says so to the report group, once. Returns 1 when queued.
 */
export async function alertHandCreditedDeposit(
  db: Db,
  args: { txId: string; userId: number; invoicePublicId: string; expectedIrr: number; handCredit: HandCredit },
): Promise<number> {
  const target = await paymentReportTarget(db);
  if (!target) return 0;
  const row = await db
    .prepare(
      `SELECT t.amount_irr, COALESCE(t.bank_timestamp, t.created_at) AS at, fa.display_name,
              u.username, u.telegram_id
         FROM transaction_candidates t
         JOIN financial_accounts fa ON fa.id = t.financial_account_id
         JOIN users u ON u.id = ?2
        WHERE t.id = ?1`,
    )
    .bind(args.txId, args.userId)
    .first<{ amount_irr: number | string; at: number | string; display_name: string; username: string | null; telegram_id: number | string }>();
  if (!row) return 0;
  const lines = [
    '✋ ربات این واریزی را به کیف پول نبرد',
    `${toman(Number(row.amount_irr))} تومان — ${row.display_name}، ${FA_WHEN.format(Number(row.at))}`,
    `فاکتور ${args.invoicePublicId} (${toman(args.expectedIrr)} تومان) — مشتری ${row.username ? `@${row.username}` : String(row.telegram_id)}`,
    'مبلغ با فاکتور یکی نبود و ربات معمولاً آن را به کیف پول مشتری می‌برد.',
    handCreditLine(args.handCredit),
    'اگر همان پول نبوده، در «پرداخت‌ها › واریزی‌ها» روی این واریزی «شارژ کیف پول» بزن.',
  ];
  return queuePaymentReport(db, target, handCreditedDedupeKey(args.txId), lines);
}

function toman(irr: number): string {
  return FA_NUMBER.format(Math.floor(irr / 10));
}

function handCreditLine(h: HandCredit): string {
  const who = [FA_WHEN.format(h.at), h.actor, h.note ? `«${h.note}»` : null].filter(Boolean).join('، ');
  return `⚠️ این مشتری بعد از این واریزی ${toman(h.amountIrr)} تومان دستی شارژ گرفته (${who}). اگر همان پول بوده، دوباره شارژ نکن؛ وگرنه دو بار پرداخت می‌شود.`;
}

type ReportTarget = { chatId: number; thread: number | null };

/** The report group and its «💰 گزارش مالی» topic, or null when none is set. */
async function paymentReportTarget(db: Db): Promise<ReportTarget | null> {
  const settings = await db
    .prepare(`SELECT key, value FROM settings WHERE scope = 'bot' AND key IN ('Channel_Report', ?1)`)
    .bind(reportTopicKey('paymentreport'))
    .all<{ key: string; value: unknown }>();
  const setting = (key: string) => Number(settings.results.find((r) => r.key === key)?.value);
  const chatId = setting('Channel_Report');
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  const topic = setting(reportTopicKey('paymentreport'));
  return { chatId, thread: Number.isSafeInteger(topic) && topic > 0 ? topic : null };
}

async function queuePaymentReport(db: Db, target: ReportTarget, dedupeKey: string, lines: string[]): Promise<number> {
  const written = await db
    .prepare(
      `INSERT INTO bot_notifications (dedupe_key, chat_id, body, message_thread_id)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(dedupeKey, target.chatId, lines.join('\n'), target.thread)
    .run();
  return written.meta.changes;
}
