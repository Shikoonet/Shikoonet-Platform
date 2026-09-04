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

/**
 * Who an announcement is for.
 *
 * A broadcast went to every active customer and there was no way to say
 * otherwise. Sam asked for four audiences; three are here, and the fourth is
 * not, because the data was asked before the code was written.
 *
 * **Every branch below was measured against the imported production data on
 * 2026-09-04 before it was built**, and the numbers are in the comments. That
 * is not decoration: two of the obvious ways to write these select NOBODY on
 * real data while looking perfectly correct, and an audience that silently
 * means «nobody» is indistinguishable from one that means «nobody is left».
 *
 * The fourth, «took a trial and never bought», is deliberately absent.
 * `users.test_quota_used` is 1 for 15,329 of 15,847 active customers, 0 for
 * 586 and -15 for one: it is the legacy `limit_usertest` ALLOWANCE, not a count
 * of trials taken. A control labelled «کسانی که اکانت تست گرفته‌اند» that
 * selects almost everybody is worse than no control.
 */
export type BroadcastAudience =
  | { kind: 'all' }
  | { kind: 'never_bought' }
  | { kind: 'service_ended' }
  | { kind: 'provider'; providerId: number };

/**
 * The audience as a SQL predicate, written once so the preview and the send
 * cannot disagree.
 *
 * That is the whole reason this is a function rather than two similar WHERE
 * clauses: the count an operator approves has to be a count of the rows that
 * are then inserted. Two spellings agree until somebody edits one.
 *
 * `from` is the first free parameter index, because the two callers have
 * different numbers of their own. `@shikoo/db` refuses a statement that mixes
 * `?N` and `?`, so the numbering is explicit rather than positional.
 */
export function audienceSql(
  audience: BroadcastAudience,
  from: number,
): { sql: string; params: unknown[] } {
  switch (audience.kind) {
    case 'all':
      // 15,847 active customers, measured. Today's behaviour, unchanged.
      return { sql: '', params: [] };

    case 'never_bought':
      // Started the bot and never completed an order — 11,037 of 15,847. The
      // largest audience the shop has, and the one with something to say to it.
      return {
        sql: `AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.user_id = u.id AND o.status = 'COMPLETED')`,
        params: [],
      };

    case 'service_ended':
      /*
       * Had a service, has none now — 196 people.
       *
       * NOT written as «expires_at is in the past», which is the obvious
       * spelling and selects TWO people. `subscriptions.expires_at` is NULL on
       * 8,421 of 8,428 rows because the importer never writes that column, and
       * the handful that do have one are `seed:sim` fixtures. Issue #92.
       *
       * So the question is asked of `status`, which the panel sync does
       * maintain: DISABLED (243) and REMOVED (62) are where a service goes when
       * it ends, and `legacy_status` records why — `removeTime`,
       * `removevolume`, `removebyuser`, `disabled`.
       *
       * When #92 lands this can become the more precise thing. Until then this
       * is the honest one, and it finds 196 people rather than 2.
       */
      return {
        sql: `AND EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.status IN ('DISABLED', 'REMOVED'))
              AND NOT EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.status = 'ACTIVE')`,
        params: [],
      };

    case 'provider':
      /*
       * Holds a live service on one particular panel. Measured per panel:
       * «خرید اولی ها» 2,288 · «تیتانیوم» 1,299 · «نامحدود» 612 ·
       * «طلایی» 159 · «الماس» 104 · «Tech Immigrants» 47.
       *
       * By ID from the catalogue, never by matching `plan_name_at_sale`: a
       * rename would empty the audience with nothing to see. That instruction
       * holds — but NOT with the column it was written for.
       * `subscriptions.plan_id` is NULL on 5,352 of 5,357 active rows, so a
       * plan picker would select nobody at all, which is worse than the rename
       * it was guarding against. `provider_id` is populated on 5,241 of them,
       * and is the id the bulk-pricing picker on this same screen already uses.
       *
       * The 116 active services carrying no `provider_id` are reachable by
       * «همه» and by no panel. Said here because it is invisible on the screen.
       */
      return {
        sql: `AND EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.status = 'ACTIVE'
                   AND s.provider_id = ?${from})`,
        params: [audience.providerId],
      };
  }
}

/**
 * How many customers a bulk action would reach, before committing to it.
 *
 * Takes the audience, so the number on the confirmation counts exactly the rows
 * the send will insert. An announcement an operator believed was for a hundred
 * people and is really for fifteen thousand has to be visible BEFORE the press,
 * and sharing one predicate with `queueBroadcast` is what makes it so.
 */
export async function activeCustomerCount(
  db: Db,
  audience: BroadcastAudience = { kind: 'all' },
): Promise<number> {
  const { sql, params } = audienceSql(audience, 1);
  const stmt = db.prepare(
    `SELECT count(*)::int AS n FROM users u WHERE u.status = 'ACTIVE' ${sql}`,
  );
  const row = await (params.length > 0 ? stmt.bind(...params) : stmt).first<{ n: number }>();
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
 *
 * The audience is one extra condition on the SELECT that fills
 * `broadcast_recipients` — not a second table and not a second path. Everything
 * that makes this safe is untouched: the list is still snapshotted here, so
 * somebody who joins the audience mid-send does not receive a message about
 * something that started before they qualified, and the primary key still stops
 * anybody hearing twice.
 */
export async function queueBroadcast(
  db: Db,
  broadcastId: string,
  content: BroadcastContent,
  createdBy: number,
  audience: BroadcastAudience = { kind: 'all' },
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
  // `?2` onwards belongs to the audience; `?1` is the broadcast.
  const { sql, params } = audienceSql(audience, 2);
  const done = await db
    .prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id)
       SELECT ?1, u.id, u.telegram_id FROM users u WHERE u.status = 'ACTIVE' ${sql}
       ON CONFLICT (broadcast_id, user_id) DO NOTHING`,
    )
    .bind(broadcastId, ...params)
    .run();
  return done.meta.changes;
}
