/**
 * «پست کانال» (#473) — the bot sends what the panel scheduled, at most once.
 *
 * The tool this replaces posted to the channel and then told the operator it
 * had failed, so the operator posted again. A post in a channel cannot be
 * taken back from the people who already read it, so this file's one rule is:
 * when it is not known whether Telegram took a post, it is not sent again.
 *
 * One post per call, claimed by the statement that reads it (CLAUDE.md rule 9),
 * so two bot processes cannot both send it. What goes out is a copy of the
 * preview the operator looked at in the reports group, with the keyboard that
 * preview was built with — never a second rendering of the text.
 *
 * The four ways a send ends:
 *   - Telegram answered with the new message → SENT, with its id.
 *   - Telegram said wait (429) → it did NOT send; back to SCHEDULED after the
 *     wait, and the whole bot pauses, as it does for every 429 (`pace.ts`).
 *   - Telegram refused (400, 403, …) → nothing went out; FAILED with its reason,
 *     and the operator can fix it and send it again.
 *   - Anything else — a timeout, a closed socket, a 5xx — the post may or may
 *     not be in the channel. It stays SENDING, and a person decides.
 */

import type { D1Database } from '@shikoo/database';
import { createLogger } from '@shikoo/domain';
import { sendGapMs } from './broadcast.js';
import { consumeSlot, pauseFor, pausedFor } from './pace.js';
import { rateLimitedForMs, TelegramRejection, type TelegramApi } from './telegram.js';

const log = createLogger('bot');

interface Claimed {
  id: number;
  chat_id: number;
  preview_chat_id: number;
  preview_message_id: number;
  reply_markup: unknown;
}

/**
 * A keyboard of links and nothing else. Checked again here although the panel
 * built it: a `callback_data` button in a public channel would drive the bot's
 * own callback handler as whoever pressed it.
 */
export function onlyLinkButtons(markup: unknown): boolean {
  if (markup === null || markup === undefined) return true;
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return false;
  return rows.every(
    (row) =>
      Array.isArray(row) &&
      row.every((b) => {
        if (typeof b !== 'object' || b === null) return false;
        const keys = Object.keys(b);
        const url = (b as { url?: unknown }).url;
        return (
          typeof url === 'string' &&
          /^(https|tg):\/\//i.test(url) &&
          keys.every((k) => ['text', 'url', 'style', 'icon_custom_emoji_id'].includes(k))
        );
      }),
  );
}

/** Sends the one channel post most overdue, if any. Returns how many it handled: 0 or 1. */
export async function sendDueChannelPost(db: D1Database, api: TelegramApi): Promise<number> {
  // A ban is the bot's, whichever loop earned it: nothing is claimed into it.
  if (pausedFor() > 0) return 0;

  const post = await db
    .prepare(
      `WITH due AS MATERIALIZED (
         SELECT id FROM channel_posts
          WHERE status = 'SCHEDULED' AND send_at <= now()
          ORDER BY send_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE channel_posts
          SET status = 'SENDING', claimed_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM due)
       RETURNING id, chat_id, preview_chat_id, preview_message_id, reply_markup`,
    )
    .first<Claimed>();
  if (!post) return 0;
  const id = Number(post.id);

  const settle = (sql: string, ...binds: unknown[]) =>
    db
      .prepare(sql)
      .bind(id, ...binds)
      .run()
      .catch((err: unknown) => log.error('channel_post.unrecorded', { ref: String(id) }, err));

  if (!onlyLinkButtons(post.reply_markup)) {
    await settle(
      `UPDATE channel_posts SET status = 'FAILED', error = ?2, updated_at = now()
        WHERE id = ?1 AND status = 'SENDING'`,
      'دکمه‌ای غیر از لینک در پست بود — ارسال نشد.',
    );
    return 1;
  }

  let messageId: number;
  try {
    messageId = await api.copyMessage(
      Number(post.chat_id),
      Number(post.preview_chat_id),
      Number(post.preview_message_id),
      post.reply_markup,
    );
  } catch (err) {
    const waitMs = rateLimitedForMs(err);
    if (waitMs !== null) {
      await pauseFor(db, waitMs);
      await settle(
        `UPDATE channel_posts
            SET status = 'SCHEDULED', claimed_at = NULL,
                send_at = now() + make_interval(secs => ?2 / 1000.0), updated_at = now()
          WHERE id = ?1 AND status = 'SENDING'`,
        waitMs,
      );
    } else if (err instanceof TelegramRejection && err.code !== undefined && err.code < 500) {
      await settle(
        `UPDATE channel_posts SET status = 'FAILED', error = ?2, updated_at = now()
          WHERE id = ?1 AND status = 'SENDING'`,
        err.message.slice(0, 500),
      );
    } else {
      // Unknown whether it went: left SENDING, and said so where people look.
      log.error('channel_post.outcome_unknown', { ref: String(id) }, err);
    }
    return 1;
  }

  consumeSlot(sendGapMs());
  await settle(
    `UPDATE channel_posts
        SET status = 'SENT', message_id = ?2, sent_at = now(), error = NULL, updated_at = now()
      WHERE id = ?1 AND status = 'SENDING'`,
    messageId,
  );
  return 1;
}
