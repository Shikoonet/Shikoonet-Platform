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
import { stripMarkup } from '@shikoo/contracts';
import {
  isPermanentRejection,
  MAX_CAPTION_LENGTH,
  rateLimitedForMs,
  TelegramRejection,
  type InlineKeyboard,
  type TelegramApi,
} from './telegram.js';
import { copyLinkMenu, wireguardConfigCaption } from './menu.js';
import { qrPng } from './qr.js';
import { markUnreachable, sendGapMs } from './broadcast.js';
import { consumeSlot, pauseFor, pausedFor } from './pace.js';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

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
   * A forum topic in the reports group, for a message that is a report.
   *
   * Decided by the PRODUCER and stored, not looked up when the message is
   * sent: the producer is the only thing that knows which report this is, and a
   * settings change between queueing and sending would otherwise move a message
   * whose destination had already been decided.
   *
   * Absent, null, and zero all mean «no topic» — zero is legacy's own
   * unconfigured sentinel and reaches Telegram as no field at all.
   */
  threadId?: number | null;
  /**
   * A string to send as a QR image ahead of the text — in practice the
   * subscription link. The customer's next step after buying is to get the
   * config into an app on a phone, and a photo they point a camera at beats a
   * long URL they have to select without a keyboard.
   *
   * The text goes as the picture's caption when it fits — one message — and
   * as a second message under it when it does not.
   */
  qrPayload?: string | null;
  /**
   * A message of ours to REPLACE with this text instead of sending a new one.
   *
   * The expiry sweep uses it to turn the invoice itself into «منقضی شد», so
   * the card number stops standing in the customer's chat. Best effort: an
   * edit Telegram refuses — the message is older than 48 hours, the customer
   * deleted it — falls back to a fresh message, exactly as `poll.ts` does for
   * a reply. A message that is not delivered at all is the failure this table
   * exists to prevent; a message in the wrong place is not.
   */
  editMessageId?: number | null;
  /**
   * A file to send INSTEAD of the text — a shelf's config or tutorial (#377).
   *
   * Its own row rather than a column beside a text, so each file is its own
   * unit of retry and the text is never sent twice because a file after it
   * was refused. `kind` picks the Telegram method: the three `file_id` spaces
   * are distinct and Telegram refuses one given to another's method.
   */
  file?: { kind: AttachmentKind; fileId: string } | null;
  /**
   * Send `text` AS a file with this name instead of as a message — a
   * WireGuard config the bot built from the panel's links (0094). There is
   * no `file_id` for it: the file exists nowhere until this row sends it.
   *
   * With `qrPayload`, the picture goes first under a caption of its own and
   * without the «copy link» button. A link's picture is captioned with the
   * link itself; a config's would be captioned with the whole config — the
   * key material a second time, directly above the file that carries it —
   * and its button would offer to «copy the subscription link».
   */
  document?: { name: string } | null;
}

export type AttachmentKind = 'document' | 'video' | 'photo';

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
export async function enqueue(tx: D1DatabaseSession, note: PendingNotification): Promise<boolean> {
  const written = await tx
    .prepare(
      `INSERT INTO bot_notifications
         (dedupe_key, chat_id, body, reply_markup, qr_payload, message_thread_id,
          edit_message_id, file_kind, file_id, doc_name)
       VALUES (?1, ?2, ?3, ?4::jsonb, ?5, ?6, ?7, ?8, ?9, ?10)
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
      note.threadId ?? null,
      note.editMessageId ?? null,
      note.file?.kind ?? null,
      note.file?.fileId ?? null,
      note.document?.name ?? null,
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
  dedupe_key: string;
  chat_id: number;
  body: string;
  attempt_count: number;
  reply_markup: InlineKeyboard | string | null;
  qr_payload: string | null;
  qr_sent_at: string | null;
  message_thread_id: number | null;
  edit_message_id: number | null;
  file_kind: AttachmentKind | null;
  file_id: string | null;
  doc_name: string | null;
}

/**
 * Enough identity to make a dead row actionable without logging its customer,
 * order or payment identifier. Reports (`report:*`, `spam:*` and `alert:*`) go
 * to the configured reports group; every other producer currently targets a
 * customer.
 */
function routeOf(dedupeKey: string): { kind: string; destination: 'report' | 'customer' } {
  const kind = dedupeKey.split(':', 1)[0] || 'unknown';
  return {
    kind,
    destination: kind === 'report' || kind === 'spam' || kind === 'alert' ? 'report' : 'customer',
  };
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
 * Whether the message a row wants to edit is, RIGHT NOW, somebody's live
 * invoice. Asked at send time and not at enqueue time, because the two can be
 * an hour apart: an expiry row whose edit failed once is retried later, and by
 * then the customer may have drawn a fresh invoice on the same screen — a
 * button press edits the screen it came from, so one message carries invoice
 * after invoice. Editing it then would replace a live card number with «this
 * expired», about a different order. A live invoice is never edited from here;
 * the notice goes out as a new message instead.
 */
async function isLiveInvoice(db: D1Database, chatId: number, messageId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS live
         FROM payments p JOIN users u ON u.id = p.user_id
        WHERE u.telegram_id = ?1 AND p.invoice_message_id = ?2
          AND p.status IN ('PENDING', 'AWAITING_REVIEW')
        LIMIT 1`,
    )
    .bind(chatId, messageId)
    .first<{ live: number }>();
  return row !== null;
}

/**
 * The text itself: an edit of the message the producer named, or a new one.
 *
 * The edit falls back rather than fails, for the reason on `editMessageId`.
 * Only a `TelegramRejection` falls back — a refused edit is Telegram saying
 * «not that message»; a socket that closed says nothing about the message and
 * must reach the retry logic in the caller as what it is.
 */
async function deliver(db: D1Database, api: TelegramApi, row: DueRow): Promise<void> {
  // A file row is the file and nothing else: no text, no edit, no keyboard.
  if (row.file_id !== null) {
    if (row.file_kind === 'video') await api.sendVideo(row.chat_id, row.file_id);
    else if (row.file_kind === 'photo') await api.sendPhoto(row.chat_id, row.file_id);
    else await api.sendDocument(row.chat_id, row.file_id);
    return;
  }
  // A document row is its body, as a file: no text, no edit, no keyboard.
  if (row.doc_name !== null) {
    await api.sendDocumentBytes(row.chat_id, new TextEncoder().encode(row.body), row.doc_name);
    return;
  }
  if (row.edit_message_id !== null && !(await isLiveInvoice(db, row.chat_id, row.edit_message_id))) {
    try {
      await api.editMessageText(row.chat_id, row.edit_message_id, row.body, keyboardOf(row));
      return;
    } catch (err) {
      if (!(err instanceof TelegramRejection)) throw err;
      log.warn('notify.edit_failed', { ref: String(row.id), fallback: 'new message' }, err);
    }
  }
  await api.sendMessage(row.chat_id, row.body, keyboardOf(row), row.message_thread_id);
}

/**
 * Whether a row's text can go as its QR picture's caption instead of as a
 * second message.
 *
 * Only a plain new message — a file, an edit or a topic is a different send —
 * and only one Telegram will take whole as a caption: a card past the limit
 * keeps the two-message form rather than lose its tail. Measured without the
 * markup, because Telegram counts the caption after parsing it.
 */
function fitsUnderPicture(row: DueRow): boolean {
  return (
    row.file_id === null &&
    row.doc_name === null &&
    row.edit_message_id === null &&
    row.message_thread_id === null &&
    stripMarkup(row.body).length <= MAX_CAPTION_LENGTH
  );
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

  // Telegram has said wait, to the other loop or to this one: sending a
  // receipt into a ban does not deliver it and lengthens the ban for the
  // broadcast (#364). Nothing is claimed, so nothing burns an attempt; the
  // rows are simply still due when the pause lifts. Against the wall clock,
  // not `opts.now`: the ban is Telegram's, and `now` is this queue's own
  // bookkeeping clock, which the tests pin to a date.
  if (pausedFor() > 0) return result;

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
          RETURNING id, dedupe_key, chat_id, body, attempt_count,
                    reply_markup, qr_payload, qr_sent_at, message_thread_id,
                    edit_message_id, file_kind, file_id, doc_name`,
      )
      .bind(now, limit, LEASE_MS)
      .all<DueRow>();
    // The CTE picks the batch in order; the UPDATE's RETURNING gives it back
    // in whatever order the plan touched the rows — CI showed a shelf's file
    // ahead of the message it belongs under (#377). Ids are issued in the
    // order rows were queued, and a retried row is older than a fresh one,
    // so this is the CTE's own order, restated where it actually holds.
    rows = (results ?? []).sort((a, b) => Number(a.id) - Number(b.id));
  } catch (err) {
    log.error('notify.claim_failed', { will_retry: true }, err);
    return result;
  }

  for (const row of rows) {
    // A 429 from an earlier row of THIS batch, or from the broadcast loop
    // meanwhile: the rest of the batch is not offered into the ban
    // (CodeRabbit on #372). The rows keep their lease and are due again when
    // it lapses — sixty seconds, which no ban Telegram has handed this bot
    // was shorter than — and nothing burns an attempt.
    if (pausedFor() > 0) break;
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
      //
      // When the text fits under the picture it IS the caption, and the row is
      // one message rather than two (Sam, 2026-09-26). A failure there falls
      // back to the text alone, for the same reason as above.
      let delivered = false;
      if (row.qr_payload !== null && row.qr_sent_at === null) {
        try {
          const png = await qrPng(row.qr_payload);
          if (fitsUnderPicture(row)) {
            // «Copy link» on top, next to the link; the card's own buttons under it.
            const keys = [...(copyLinkMenu(row.qr_payload) ?? []), ...(keyboardOf(row) ?? [])];
            await api.sendPhotoBytes(row.chat_id, png, row.body, keys.length > 0 ? keys : undefined);
            delivered = true;
          } else {
            // A config's picture says what it is and offers no «copy link»:
            // it is not a link, and the file under it is the thing to keep.
            const config = row.doc_name !== null;
            await api.sendPhotoBytes(
              row.chat_id,
              png,
              config ? wireguardConfigCaption() : row.qr_payload,
              config ? undefined : copyLinkMenu(row.qr_payload),
            );
            await markQrSent(db, row.id);
          }
        } catch (err) {
          log.warn('notify.qr_failed', { ref: String(row.id), fallback: 'text only' }, err);
        }
      }
      if (!delivered) await deliver(db, api, row);
      // This message took the broadcast's next slot. The outbox is not paced
      // — a customer's receipt does not wait two seconds behind an
      // announcement — but it is COUNTED, so the bot's rate stays the rate
      // whichever queue a message came from (#364).
      consumeSlot(sendGapMs());
      await settle(db, row.id, 'SENT', null, null);
      result.sent += 1;
      continue;
    } catch (err) {
      // A 429 holds both loops, not just this row (#364).
      const waitMs = rateLimitedForMs(err);
      if (waitMs !== null) await pauseFor(db, waitMs);
      // A customer who blocked the bot is not reachable by trying harder, and
      // eight attempts at one of those is eight attempts not spent on somebody
      // who can still be told.
      const permanent = isPermanentRejection(err);
      const exhausted = row.attempt_count >= MAX_ATTEMPTS;
      if (permanent || exhausted) {
        await settle(db, row.id, 'DEAD', String(err), null);
        /*
         * Marked here, in the one place that learns it, rather than in each
         * sweep that keeps finding out the hard way.
         *
         * A 403 is Telegram saying this customer blocked the bot or deleted the
         * chat. Nothing wrote that down: `notify_enabled` stayed true, so
         * `warn.ts` queued them another expiry warning on every cycle,
         * `nudge.ts` kept nudging, every broadcast counted them as a recipient
         * and failed, and the DEAD rows accumulated in a table nothing prunes.
         * One row per attempt, for ever, for somebody who cannot be reached.
         *
         * Every one of those sweeps already filters on `u.notify_enabled`, so
         * this single write silences all of them. Only for a message that was
         * going to a CUSTOMER: a 403 from the reports group means the bot was
         * removed from the group, which says nothing about anybody's switch.
         */
        if (permanent && routeOf(row.dedupe_key).destination === 'customer') {
          // Its own catch, like every other write on this path.
          //
          // `settle` and `markQrSent` both swallow their failures here for the
          // same reason: this loop has no handler of its own, so a rejection
          // escapes `flush` entirely and abandons the rest of the batch — and
          // the broadcast sweep after it. The row is already DEAD by this
          // point, so losing this flag costs one more silenced sweep for one
          // customer. Losing the batch costs every other customer's message.
          await markUnreachable(db, row.chat_id).catch((e: unknown) => {
              log.warn('notify.silence_unrecorded', { ref: String(row.id) }, e);
            });
        }
        result.dead += 1;
        // A customer who blocked the bot is an outcome, not a fault: handled
        // above, and nobody can act on it. It filled the alert channel (six of
        // nine alerts, 2026-09-23/24). A 400 is our message being refused, a
        // 403 from the reports group is the bot removed from it, and running
        // out of attempts is Telegram failing us — those still alert.
        const blocked = err instanceof TelegramRejection && err.code === 403;
        const customer = routeOf(row.dedupe_key).destination === 'customer';
        log[blocked && customer ? 'warn' : 'error'](
          'notify.dead',
          {
            ref: String(row.id),
            attempts: row.attempt_count,
            permanent,
            ...routeOf(row.dedupe_key),
          },
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
    log.error('notify.qr_unrecorded', {}, err);
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
    // A generated document's text is a WireGuard config — a private key. It
    // is needed until the row stops being retried and not a moment longer:
    // SENT and DEAD rows are kept as history, and history is in every backup.
    // Emptied at the terminal state rather than never written, because the
    // retry needs it; the key is in the database only while its row is due
    // (CodeRabbit on #427). Not the subscription URL's problem by extension —
    // `revoke_sub` rotates that token, and does not rotate the WireGuard key,
    // so a kept config would outlive the revoke that retires the link.
    await db
      .prepare(
        `UPDATE bot_notifications
            SET status = ?2,
                last_error = ?3,
                next_attempt_at = ?4,
                sent_at = CASE WHEN ?2 = 'SENT' THEN now() ELSE sent_at END,
                body = CASE WHEN ?2 IN ('SENT', 'DEAD') AND doc_name IS NOT NULL THEN '' ELSE body END,
                qr_payload = CASE WHEN ?2 IN ('SENT', 'DEAD') AND doc_name IS NOT NULL
                                  THEN NULL ELSE qr_payload END
          WHERE id = ?1`,
      )
      .bind(id, status, error, nextAttemptAt)
      .run();
  } catch (err) {
    // The message may well have been delivered; only the bookkeeping failed.
    // The lease expires on its own, so the worst case is one duplicate rather
    // than a stuck row — and saying so is better than throwing out of a loop
    // that still has messages to send.
    log.error('notify.outcome_unrecorded', { ref: String(id) }, err);
  }
}
