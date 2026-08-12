/**
 * One Telegram update in, database writes and outgoing replies out.
 *
 * The shape of this file is the whole point of migration 0006. Everything that
 * touches the database happens inside ONE transaction that begins by claiming
 * `update_id`. If the claim loses, the update was already handled and nothing
 * runs. If anything after the claim throws, the claim rolls back with it and
 * Telegram's redelivery gets a real second attempt. There is no window in which
 * an update counts as handled but its effects are missing.
 *
 * Replies are returned, not sent. Sending is not transactional — a message that
 * has left cannot be un-sent by a ROLLBACK — so the caller sends only after the
 * transaction commits. The cost is the narrow case of a commit whose reply then
 * fails to send: the user sees silence, the database stays correct. That is the
 * right way round for a system that moves money.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import type { TelegramMessage, TelegramUpdate } from './telegram.js';

export interface Reply {
  chatId: number;
  text: string;
}

export type HandleStatus =
  /** Claimed and acted on. */
  | 'processed'
  /** Already claimed by an earlier delivery; nothing ran. */
  | 'duplicate'
  /** Claimed, but there was nothing here for us — an unknown command, a
   *  non-message update, or a blocked user. */
  | 'ignored';

export interface HandleOutcome {
  status: HandleStatus;
  replies: Reply[];
}

// ponytail: Persian only, inline. The legacy bot has four language files and a
// `lang` column already exists on users; wire it up when a second language has
// an actual customer.
const WELCOME = 'به شیکو خوش آمدید 👋\n\nبرای دیدن محصولات و خرید، از منوی زیر استفاده کنید.';

export async function handleUpdate(db: D1Database, update: TelegramUpdate): Promise<HandleOutcome> {
  return db.withSession(async (tx) => {
    const claim = await tx
      .prepare(`INSERT INTO telegram_updates (update_id) VALUES (?1) ON CONFLICT DO NOTHING`)
      .bind(update.update_id)
      .run();
    if (claim.meta.changes === 0) {
      return { status: 'duplicate', replies: [] };
    }

    const message = update.message;
    // Claimed on purpose: we have genuinely seen this update, and re-fetching it
    // would produce the same nothing.
    if (!message?.text || !message.from) {
      return { status: 'ignored', replies: [] };
    }

    if (command(message.text) === '/start') {
      return handleStart(tx, message);
    }
    return { status: 'ignored', replies: [] };
  });
}

/** `/start@some_bot payload` -> `/start`. */
function command(text: string): string | null {
  const first = text.trim().split(/\s+/)[0];
  if (first === undefined || !first.startsWith('/')) return null;
  return first.split('@')[0] ?? null;
}

async function handleStart(
  tx: D1DatabaseSession,
  message: TelegramMessage,
): Promise<HandleOutcome> {
  const from = message.from;
  if (!from) return { status: 'ignored', replies: [] };

  // Upsert rather than SELECT-then-INSERT: two customers cannot race into two
  // rows for one telegram_id, because the unique index decides, not this code.
  //
  // `lang` is only set on insert. A customer who changed it in the bot must not
  // have that undone by their phone's locale on the next /start.
  const user = await tx
    .prepare(
      `INSERT INTO users (telegram_id, username, lang, registered_at, last_seen_at)
       VALUES (?1, ?2, ?3, now(), now())
       ON CONFLICT (telegram_id) DO UPDATE
         SET username = EXCLUDED.username,
             last_seen_at = now(),
             updated_at = now()
       RETURNING id, status`,
    )
    .bind(from.id, from.username ?? null, from.language_code === 'en' ? 'en' : 'fa')
    .first<{ id: number; status: string }>();
  if (!user) throw new Error('user upsert returned no row');

  // A blocked customer is still recorded as seen — that is what `last_seen_at`
  // is for — but gets no reply and no session.
  if (user.status === 'BLOCKED') {
    return { status: 'ignored', replies: [] };
  }

  // /start is the reset button: whatever half-finished flow the customer was in
  // is abandoned, which is exactly what they expect it to do.
  await tx
    .prepare(
      `INSERT INTO bot_sessions (user_id, step, data, updated_at)
       VALUES (?1, NULL, '{}'::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET step = NULL, data = '{}'::jsonb, updated_at = now()`,
    )
    .bind(user.id)
    .run();

  return {
    status: 'processed',
    replies: [{ chatId: message.chat.id, text: WELCOME }],
  };
}
