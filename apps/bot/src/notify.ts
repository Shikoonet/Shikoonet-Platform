/**
 * The messages a customer is owed, and how they stop being lost.
 *
 * ## What this replaces
 *
 * Every sweep used to claim its rows, return `Notification[]`, and let
 * `poll.ts` send them. A `sendMessage` that threw was logged and the message
 * was gone — the row had already advanced, so it would never be produced
 * again. That was written down as a deliberate trade: losing a message is the
 * price of never sending one twice.
 *
 * The trade is the wrong way round for a shop. Telegram refusing for a few
 * seconds is ordinary; a customer who paid and was never told is not. And the
 * duplicate the trade was avoiding is prevented far more cheaply by a key
 * derived from the thing that caused the message — which is what
 * `dedupe_key` is.
 *
 * ## The two halves, and why they are separate
 *
 * `enqueue` runs **inside the producer's transaction**, beside the write that
 * claims the row. That is the whole point: a message and the state change that
 * earned it either both exist or neither does. Enqueuing after the commit
 * would leave the same hole, one line further down.
 *
 * `flush` runs after, outside any transaction, and is allowed to fail. By then
 * the intent is durable and a failure only costs a retry.
 *
 * The pattern is deliberately the same as `webhook_deliveries` in the ingest
 * worker — claim with a lease, double the backoff, give up into a terminal
 * state — because two outboxes that behave differently is one more thing to
 * remember at 3am.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { isPermanentRejection, type InlineKeyboard, type TelegramApi } from './telegram.js';
import { copyLinkMenu } from './menu.js';
import { qrPng } from './qr.js';

/** What a sweep wants said, and the key that stops it being said twice. */
export interface PendingNotification {
  /**
   * Derived from the event, never from a clock or a counter. `settle:<payment
   * public id>` is a good key; `notify-${Date.now()}` is the bug this column
   * exists to prevent.
   */
  dedupeKey: string;
  chatId: number;
  text: string;
  /** Buttons under the message. Absent for the plain one-line notices. */
  keyboard?: InlineKeyboard | null;
  /**
   * A string to send as a QR image ahead of the text — in practice the
   * subscription link. The customer's next step after buying is to get the
   * config into an app on a phone, and a photo they point a camera at beats a
   * long URL they have to select without a keyboard.
   */
  qrPayload?: string | null;
}

/** Attempts before a message stops being retried and starts needing a human. */
export const MAX_ATTEMPTS = 8;

/**
 * How long a claimed row is invisible to another sweeper.
 *
 * One bot holds the poller lock (see `singleton.ts`), so today there is only
 * ever one sweeper and this guards almost nothing. It is here for the case the
 * lock is ever relaxed, and — more usefully now — so a process killed
 * mid-send gives the row back on a timer instead of stranding it.
 */
export const LEASE_MS = 60_000;

/** Doubling from a minute, capped at an hour. Same curve as the webhook outbox. */
export function nextAttemptDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

/**
 * Record that a customer is owed a message. Call inside the transaction that
 * earns it.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: the first version of a
 * message is the true one. A producer that runs again after a partial failure
 * must not overwrite a message that may already have been delivered.
 *
 * Returns whether a row was actually written. It used to return nothing, and a
 * caller that had already decided it was sending a message had no way to learn
 * the key had collided — `warn.ts` counted, logged and marked warnings it never
 * queued. Silence about a no-op is only safe while every key is guaranteed
 * fresh, and that guarantee is the caller's, not this function's.
 */
export async function enqueue(
  tx: D1DatabaseSession,
  note: PendingNotification,
): Promise<boolean> {
  const written = await tx
    .prepare(
      `INSERT INTO bot_notifications (dedupe_key, chat_id, body, reply_markup, qr_payload)
       VALUES (?1, ?2, ?3, ?4::jsonb, ?5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      note.dedupeKey,
      note.chatId,
      note.text,
      // The keyboard itself, not Telegram's `reply_markup` envelope — that is
      // `sendMessage`'s to build, and only one file should know its shape.
      note.keyboard ? JSON.stringify(note.keyboard) : null,
      note.qrPayload ?? null,
    )
    .run();
  return written.meta.changes > 0;
}

export interface FlushResult {
  sent: number;
  failed: number;
  dead: number;
}

interface DueRow {
  id: number;
  chat_id: number;
  body: string;
  attempt_count: number;
  reply_markup: InlineKeyboard | string | null;
  qr_payload: string | null;
  qr_sent_at: string | null;
}

/**
 * `jsonb` comes back parsed from the Postgres adapter and as text from
 * anything that stores it as text. Accept both rather than assume, because the
 * cost of guessing wrong is a message sent with no buttons and no error.
 */
function keyboardOf(row: DueRow): InlineKeyboard | undefined {
  const raw = row.reply_markup;
  if (raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as InlineKeyboard;
  } catch {
    return undefined;
  }
}

/**
 * Send everything that is due, and write down what happened to each.
 *
 * Rows are claimed by the statement that reads them: `next_attempt_at` moves
 * out to a lease, so a row in flight is not due. That write is the guard — a
 * plain `SELECT ... FOR UPDATE` would not be one, because outside an explicit
 * transaction each statement commits alone and the lock is gone before the
 * caller has read anything.
 *
 * Never throws. It is called from the poll loop, and a bot that stopped
 * answering because a message would not send would be a worse bug than the one
 * this file fixes.
 */
export async function flush(
  db: D1Database,
  api: TelegramApi,
  opts: { limit?: number; now?: number } = {},
): Promise<FlushResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 50;
  const result: FlushResult = { sent: 0, failed: 0, dead: 0 };

  let rows: DueRow[];
  try {
    const { results } = await db
      .prepare(
        // `AS MATERIALIZED`, for the reason spelled out in `webhook.ts`: an
        // uncorrelated subquery may become a per-row SubPlan, and then the
        // limit bounds each execution rather than the batch. Two statements of
        // this exact shape were found broken on 2026-08-19 — a whole broadcast
        // claimed for a limit of one, eight webhook rows for a limit of three.
        // This one measured correct on the day, which is not the same as being
        // guaranteed: same SQL and same data gave different answers minutes
        // apart in the outbox. Fenced so all three hold by construction rather
        // than two by construction and one by luck.
        `WITH due AS MATERIALIZED (
            SELECT id FROM bot_notifications
             WHERE status IN ('PENDING', 'FAILED')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
             ORDER BY next_attempt_at NULLS FIRST, id
             LIMIT ?2
             FOR UPDATE SKIP LOCKED
          )
          UPDATE bot_notifications
             SET attempt_count = attempt_count + 1,
                 next_attempt_at = ?1 + ?3
           WHERE id IN (SELECT id FROM due)
          RETURNING id, chat_id, body, attempt_count,
                    reply_markup, qr_payload, qr_sent_at`,
      )
      .bind(now, limit, LEASE_MS)
      .all<DueRow>();
    rows = results ?? [];
  } catch (err) {
    console.error('[bot] could not claim notifications, will retry', err);
    return result;
  }

  for (const row of rows) {
    try {
      // The picture first, so the customer's eye lands on the code and the
      // text under it explains what they are looking at.
      //
      // Marked sent in its own statement before the message goes, because the
      // two are separate Telegram calls and only the second one is retried by
      // this row failing. Without the mark, a message Telegram refuses would
      // send the customer a second QR on every attempt — up to eight of them.
      //
      // And inside its own try, because the picture is a decoration and the
      // text is the product. It was awaited ahead of `sendMessage` with nothing
      // between them, so anything that made the photo call fail — Telegram
      // refusing a photo with 400, a flood wait, a payload past the QR
      // encoder's capacity — took the message with it, through all eight
      // attempts, until the row was DEAD. A customer who paid then never
      // received the config text because the code beside it could not be drawn.
      //
      // Not marked on failure, deliberately: nothing was sent, so a retry of
      // the text should carry the picture again. What is given up is the
      // picture on the attempt that succeeds afterwards, and the text under it
      // carries the same link in full.
      if (row.qr_payload !== null && row.qr_sent_at === null) {
        try {
          await api.sendPhotoBytes(
            row.chat_id,
            await qrPng(row.qr_payload),
            row.qr_payload,
            copyLinkMenu(row.qr_payload),
          );
          await markQrSent(db, row.id);
        } catch (err) {
          console.error(`[bot] QR for chat ${row.chat_id} could not be sent; sending the text alone`, err);
        }
      }
      await api.sendMessage(row.chat_id, row.body, keyboardOf(row));
      await settle(db, row.id, 'SENT', null, null);
      result.sent += 1;
      continue;
    } catch (err) {
      // A customer who blocked the bot is not reachable by trying harder, and
      // eight attempts at one of those is eight attempts not spent on somebody
      // who can still be told.
      const permanent = isPermanentRejection(err);
      const exhausted = row.attempt_count >= MAX_ATTEMPTS;
      if (permanent || exhausted) {
        await settle(db, row.id, 'DEAD', String(err), null);
        result.dead += 1;
        console.error(
          `[bot] giving up on message to chat ${row.chat_id} after ` +
            `${row.attempt_count} attempt(s)${permanent ? ' — refused permanently' : ''}`,
          err,
        );
        continue;
      }
      await settle(db, row.id, 'FAILED', String(err), now + nextAttemptDelayMs(row.attempt_count));
      result.failed += 1;
    }
  }

  return result;
}

/**
 * The QR has left; the text has not.
 *
 * Its own statement rather than part of `settle`, because the whole point is
 * that it survives the message failing afterwards.
 */
async function markQrSent(db: D1Database, id: number): Promise<void> {
  try {
    await db
      .prepare(`UPDATE bot_notifications SET qr_sent_at = now() WHERE id = ?1`)
      .bind(id)
      .run();
  } catch (err) {
    // Losing this mark costs a duplicate picture, not a lost message, so it
    // must not abort a send that has already half-happened.
    console.error('[bot] could not mark a QR as sent', err);
  }
}

/**
 * Replace the lease with a verdict.
 *
 * `next_attempt_at` is written in every branch, including to NULL, because the
 * claim above pushed it into the future. A terminal row that kept its lease
 * would carry a due date that means nothing.
 */
async function settle(
  db: D1Database,
  id: number,
  status: 'SENT' | 'FAILED' | 'DEAD',
  error: string | null,
  nextAttemptAt: number | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE bot_notifications
            SET status = ?2,
                last_error = ?3,
                next_attempt_at = ?4,
                sent_at = CASE WHEN ?2 = 'SENT' THEN now() ELSE sent_at END
          WHERE id = ?1`,
      )
      .bind(id, status, error, nextAttemptAt)
      .run();
  } catch (err) {
    // The message may well have been delivered; only the bookkeeping failed.
    // The lease expires on its own, so the worst case is one duplicate rather
    // than a stuck row — and saying so is better than throwing out of a loop
    // that still has messages to send.
    console.error(`[bot] could not record the outcome of notification ${id}`, err);
  }
}
