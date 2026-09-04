/**
 * The two operations that touch every customer at once.
 *
 * These lived in `apps/bot/src/broadcast.ts` and were reachable only from the
 * bot's admin panel. They moved here when the web panel grew screens for the
 * same two actions, because the alternative — a second implementation behind
 * `/api/v1/admin/` — is how two panels drift apart: the same money written two
 * ways, and only one of them carrying the idempotency key that makes pressing
 * the button twice safe.
 *
 * What stayed in the bot is the part only the bot can do: claiming a batch of
 * queued messages and actually sending them. Nothing sends from here.
 *
 * ## The credit
 *
 * One `INSERT … SELECT`. Not a loop over eleven thousand customers, and not a
 * read-modify-write of any balance: `wallets.balance_irr` is derived by a
 * trigger from append-only `wallet_entries`, here as everywhere.
 *
 * The idempotency key is `bulk:<batch>:<user>`, so submitting twice on a flaky
 * connection credits each customer once. The batch id is generated when the
 * amount is entered and carried through the confirmation, which is what makes
 * it stable across a redelivered submit — the bot keeps it in its session, the
 * web page keeps it in component state and sends it with the request.
 *
 * ## The message
 *
 * The recipient list is snapshotted at confirmation time into
 * `broadcast_recipients`, then drained by the bot's poll loop a batch at a
 * time. Somebody who presses /start during the send does not receive a notice
 * about something that started before they existed.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/** Telegram refuses a longer message outright rather than truncating it. */
export const MAX_MESSAGE_LENGTH = 4096;

/** How many customers a bulk action would reach, before committing to it. */
export async function activeCustomerCount(db: Db): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A batch id, generated once and kept so a retry reuses it. */
export function newBatchId(): string {
  return randomUUID();
}

/**
 * Credits every active customer, once each.
 *
 * Returns how many wallets moved. A second call with the same batch returns 0,
 * which is the honest answer: nothing moved this time.
 */
export async function creditEveryone(
  db: Db,
  batchId: string,
  amountIrr: number,
  actor: string,
  note: string,
): Promise<number> {
  const done = await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
       SELECT u.id, ?2, 'ADMIN_ADJUST', ?3, ?4, 'bulk:' || ?1 || ':' || u.id
         FROM users u
        WHERE u.status = 'ACTIVE'
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(batchId, amountIrr, actor, note)
    .run();
  return done.meta.changes;
}

/**
 * One message to one customer, through the same two tables.
 *
 * The bot sends this one inline, because it is already holding a Telegram
 * connection and the admin is standing in the conversation. The web panel is
 * not, so it writes the message down and the bot's poll loop delivers it — the
 * same at-most-once path a broadcast takes, and the same thing that survives
 * the process restarting mid-send.
 *
 * A `broadcasts` row with one recipient rather than a second table: the drain
 * loop, the claim statement and the failure record already exist and already
 * work, and a parallel «direct_messages» would be a second thing to keep
 * correct for no behaviour anyone can see.
 *
 * Returns 0 when the customer is not active — a blocked customer is not sent
 * shop announcements, and that stays true when the message is addressed.
 */
export async function queueDirectMessage(
  db: Db,
  messageId: string,
  body: string,
  userId: number,
  createdBy: number,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO broadcasts (id, body, created_by) VALUES (?1, ?2, ?3)
              ON CONFLICT (id) DO NOTHING`,
    )
    .bind(messageId, body, createdBy)
    .run();
  const done = await db
    .prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id)
       SELECT ?1, u.id, u.telegram_id FROM users u
        WHERE u.id = ?2 AND u.status = 'ACTIVE'
       ON CONFLICT (broadcast_id, user_id) DO NOTHING`,
    )
    .bind(messageId, userId)
    .run();
  return done.meta.changes;
}

/**
 * What a broadcast carries.
 *
 * Text, or the identity of a post to pass on. The second exists because what a
 * shop announces with is a channel post — images, an album, formatting written
 * in Telegram's own editor — and none of that survives being retyped into a
 * textarea. `broadcasts` enforces the same either/or in SQL.
 */
export type BroadcastContent =
  | { kind: 'text'; body: string }
  | { kind: 'forward'; chat: string; messageId: number };

/**
 * Writes the broadcast and its recipient list down. Returns how many will get
 * it, which is fixed from this moment.
 *
 * One function for both kinds rather than two, because the half that is hard is
 * the half they share: the snapshot of recipients, the `ON CONFLICT` that makes
 * a resubmit free, and the primary key that stops anybody hearing twice. Only
 * the payload differs, and it differs in one INSERT.
 */
export async function queueBroadcast(
  db: Db,
  broadcastId: string,
  content: BroadcastContent,
  createdBy: number,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO broadcasts (id, body, source_chat, source_message_id, created_by)
            VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      broadcastId,
      content.kind === 'text' ? content.body : null,
      content.kind === 'forward' ? content.chat : null,
      content.kind === 'forward' ? content.messageId : null,
      createdBy,
    )
    .run();
  const done = await db
    .prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id)
       SELECT ?1, u.id, u.telegram_id FROM users u WHERE u.status = 'ACTIVE'
       ON CONFLICT (broadcast_id, user_id) DO NOTHING`,
    )
    .bind(broadcastId)
    .run();
  return done.meta.changes;
}
