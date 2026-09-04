/**
 * A broadcast that names a post instead of carrying text.
 *
 * ارسال گروهی could send exactly one thing: `sendMessage(chatId, text)`. What a
 * shop announces with is a channel post — images, an album, formatting an admin
 * wrote in Telegram's own editor — and none of that survives a `text` column.
 *
 * These are the four things that have to stay true now that one queue feeds two
 * Telegram methods. The first is the feature; the other three are the
 * guarantees the text path already had and which a second branch is exactly how
 * you lose: at most once, never twice, and never the two payloads at once.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';
import { sweepBroadcasts } from '../src/poll.js';

let seq = 0;

/**
 * Fixture ids, counted rather than drawn.
 *
 * A random uuid makes a failure depend on the run — the row that broke is gone
 * by the time anybody looks. The shape is still a v4 uuid because `broadcasts`
 * types the column as one.
 */
let ids = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`;

/** A broadcast with `count` recipients, all PENDING. */
async function queue(
  payload: { body: string } | { chat: string; messageId: number },
  count = 2,
): Promise<string> {
  const id = uuid();
  seq += 1;
  await db
    .prepare(
      `INSERT INTO broadcasts (id, body, source_chat, source_message_id, created_by)
            VALUES (?1, ?2, ?3, ?4, 111)`,
    )
    .bind(
      id,
      'body' in payload ? payload.body : null,
      'body' in payload ? null : payload.chat,
      'body' in payload ? null : payload.messageId,
    )
    .run();
  for (let i = 0; i < count; i++) {
    const telegramId = 760_000_000 + seq * 1000 + i;
    const userId = await makeCustomer(telegramId);
    await db
      .prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id, status)
         VALUES (?1, ?2, ?3, 'PENDING')`,
      )
      .bind(id, userId, telegramId)
      .run();
  }
  return id;
}

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  await db.prepare(`DELETE FROM broadcast_recipients`).run();
  await db.prepare(`DELETE FROM broadcasts`).run();
});

describe('a broadcast that names a channel post', () => {
  it('forwards the post to every recipient, and sends no text at all', async () => {
    const id = await queue({ chat: '@shikoonet', messageId: 137 }, 3);
    const forwarded: [number, string | number, number][] = [];
    const texted: number[] = [];

    const sent = await sweepBroadcasts(
      db,
      stubApi({
        forwardMessage: async (chatId, fromChatId, messageId) => {
          forwarded.push([chatId, fromChatId, messageId]);
        },
        sendMessage: async (chatId) => {
          texted.push(chatId);
        },
      }),
    );

    expect(sent).toBe(3);
    expect(forwarded.length).toBe(3);
    // The pair Telegram's API takes, carried through unchanged. A `t.me/…` URL
    // here would reach Telegram as a chat that does not exist.
    expect(forwarded.every(([, from, msg]) => from === '@shikoonet' && msg === 137)).toBe(true);
    // The other branch must not have run as well. A recipient who got both
    // would have been told the same thing twice by one broadcast.
    expect(texted).toEqual([]);

    const row = await db
      .prepare(
        `SELECT count(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 AND status = 'SENT'`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it('still sends text when that is what the broadcast carries', async () => {
    await queue({ body: 'سلام' }, 2);
    const forwarded: number[] = [];
    const texted: string[] = [];

    await sweepBroadcasts(
      db,
      stubApi({
        forwardMessage: async (chatId) => {
          forwarded.push(chatId);
        },
        sendMessage: async (_chatId, text) => {
          texted.push(text);
        },
      }),
    );

    expect(texted).toEqual(['سلام', 'سلام']);
    expect(forwarded).toEqual([]);
  });

  /**
   * A forward that Telegram refuses is one recipient's failure, not the
   * broadcast's — the ordinary cause on the text path is a customer who blocked
   * the bot, and it is the same here. What must NOT happen is the row going
   * back to PENDING and being forwarded again on the next cycle.
   */
  it('records a refused forward against the one recipient, and does not retry it', async () => {
    const id = await queue({ chat: '@shikoonet', messageId: 137 }, 1);
    const api = stubApi({
      forwardMessage: async () => {
        throw new Error('Forbidden: bot was blocked by the user');
      },
    });

    await sweepBroadcasts(db, api);
    const first = await db
      .prepare(
        `SELECT status, error FROM broadcast_recipients WHERE broadcast_id = ?1`,
      )
      .bind(id)
      .first<{ status: string; error: string | null }>();
    expect(first?.status).toBe('FAILED');
    expect(first?.error ?? '').toContain('blocked');

    // A second sweep finds nothing to do with it.
    let tried = 0;
    await sweepBroadcasts(
      db,
      stubApi({
        forwardMessage: async () => {
          tried += 1;
        },
      }),
    );
    expect(tried).toBe(0);
  });

  /**
   * The database's own guard, asserted here rather than trusted.
   *
   * `broadcasts` allows text OR a named post, never both and never neither.
   * Without that, a row holding both would reach the send loop and the loop
   * would pick one — silently, and differently from whatever the panel showed
   * the operator. Postgres is the outside truth for this, not our own types.
   */
  it('will not store a broadcast that is both, or neither', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO broadcasts (id, body, source_chat, source_message_id, created_by)
                VALUES (?1, 'سلام', '@shikoonet', 137, 111)`,
        )
        .bind(uuid())
        .run(),
    ).rejects.toThrow();

    await expect(
      db
        .prepare(
          `INSERT INTO broadcasts (id, body, source_chat, source_message_id, created_by)
                VALUES (?1, NULL, NULL, NULL, 111)`,
        )
        .bind(uuid())
        .run(),
    ).rejects.toThrow();

    // And the shape that looks right and is not: the URL an operator pastes.
    await expect(
      db
        .prepare(
          `INSERT INTO broadcasts (id, body, source_chat, source_message_id, created_by)
                VALUES (?1, NULL, 'https://t.me/shikoonet', 137, 111)`,
        )
        .bind(uuid())
        .run(),
    ).rejects.toThrow();
  });
});
