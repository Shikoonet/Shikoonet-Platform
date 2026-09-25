/**
 * A broadcast an admin took out of the queue (migration 0100).
 *
 * What is pinned: the sender claims nothing more of a cancelled broadcast —
 * including a row that is PENDING only because a 429 handed it back after the
 * cancel — the one behind it goes instead, and the cancelled one is closed
 * rather than left «in the queue» for ever.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';
import { sweepBroadcasts } from '../src/poll.js';

process.env['BROADCAST_SEND_GAP_MS'] = '50';

let seq = 0;
let ids = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`;

async function queue(count: number): Promise<{ id: string; telegramIds: number[] }> {
  const id = uuid();
  seq += 1;
  await db
    .prepare(`INSERT INTO broadcasts (id, body, created_by) VALUES (?1, 'سلام', 111)`)
    .bind(id)
    .run();
  const telegramIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const telegramId = 781_000_000 + seq * 1000 + i;
    const userId = await makeCustomer(telegramId);
    telegramIds.push(telegramId);
    await db
      .prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id, status)
         VALUES (?1, ?2, ?3, 'PENDING')`,
      )
      .bind(id, userId, telegramId)
      .run();
  }
  return { id, telegramIds };
}

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  await db.prepare(`DELETE FROM broadcast_recipients`).run();
  await db.prepare(`DELETE FROM broadcasts`).run();
});

describe('a cancelled broadcast', () => {
  it('sends nothing more of it, sends the next one, and closes it', async () => {
    const first = await queue(2);
    const second = await queue(1);
    // The cancel as the route leaves it — plus one row still PENDING, as a
    // 429 on a row in flight at that moment would hand it back.
    await db.prepare(`UPDATE broadcasts SET cancelled_at = now() WHERE id = ?1`).bind(first.id).run();

    const to: number[] = [];
    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async (chatId: number) => {
          to.push(chatId);
          return { messageId: 1 };
        },
      }),
    );

    expect(to).toEqual(second.telegramIds);
    const rows = await db
      .prepare(
        `SELECT status, error FROM broadcast_recipients WHERE broadcast_id = ?1 ORDER BY user_id`,
      )
      .bind(first.id)
      .all<{ status: string; error: string | null }>();
    expect(rows.results).toEqual([
      { status: 'FAILED', error: 'cancelled' },
      { status: 'FAILED', error: 'cancelled' },
    ]);
    const closed = await db
      .prepare(`SELECT finished_at IS NOT NULL AS done FROM broadcasts WHERE id = ?1`)
      .bind(first.id)
      .first<{ done: boolean }>();
    expect(closed?.done).toBe(true);
  });
});
