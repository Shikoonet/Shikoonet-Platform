/**
 * A report reaches the right topic, and an unconfigured one changes nothing.
 *
 * Sam asked for a Telegram group with a topic per kind of report. The whole
 * risk in that is the day it ships: every shop has `Channel_Report` set and no
 * topics made, and if a zero reached Telegram as `message_thread_id: 0` the
 * answer would be a 400 on every report the shop sends.
 *
 * So the assertions are about the FIELD as it reaches the API — not about the
 * column, which would pass just as happily with a zero on its way out.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { enqueue, flush } from '../src/notify.js';
import type { TelegramApi } from '../src/telegram.js';
import { db } from './helpers/env.js';

const NOW = 1_786_100_000_000;
const GROUP = -1_001_555_000;

interface Sent {
  chatId: number;
  text: string;
  threadId: number | null | undefined;
}

/** Records exactly what the outbox handed the API, including the fourth argument. */
function recorder(): { sent: Sent[]; api: TelegramApi } {
  const sent: Sent[] = [];
  const api = {
    sendMessage: (
      chatId: number,
      text: string,
      _keyboard?: unknown,
      threadId?: number | null,
    ): Promise<void> => {
      sent.push({ chatId, text, threadId });
      return Promise.resolve();
    },
  } as unknown as TelegramApi;
  return { sent, api };
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'rt-%'`).run();
});

describe('a report queued for a topic', () => {
  it('hands the thread id to Telegram', async () => {
    await db.withSession((tx) =>
      enqueue(tx, { dedupeKey: 'rt-1', chatId: GROUP, text: 'money', threadId: 42 }),
    );

    const { sent, api } = recorder();
    await flush(db, api, { now: NOW });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: GROUP, threadId: 42 });
  });

  it('keeps the topic through a retry', async () => {
    // The column, not a value the producer still holds: `flush` reads the row
    // back on every attempt, and a topic dropped on retry would move a report
    // that failed once into General for ever.
    await db.withSession((tx) =>
      enqueue(tx, { dedupeKey: 'rt-2', chatId: GROUP, text: 'money', threadId: 7 }),
    );
    let attempt = 0;
    const seen: (number | null | undefined)[] = [];
    const api = {
      sendMessage: (_c: number, _t: string, _k?: unknown, threadId?: number | null) => {
        seen.push(threadId);
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('telegram down')) : Promise.resolve();
      },
    } as unknown as TelegramApi;

    await flush(db, api, { now: NOW });
    // Past the backoff the first failure set.
    await flush(db, api, { now: NOW + 60 * 60 * 1000 });

    expect(seen).toEqual([7, 7]);
  });
});

describe('a report queued before the topics exist', () => {
  /**
   * The state every shop is in on the day this ships.
   *
   * `undefined`, not `0`. Telegram answers 400 to `message_thread_id: 0`, and
   * the message that would carry it is a report about a purchase somebody has
   * already paid for. Legacy strips the field for the same reason
   * (`botapi.php:10`), which is why zero is the value both the importer and
   * migration 0049 seed.
   */
  it('sends no thread id at all rather than a zero', async () => {
    await db.withSession((tx) =>
      enqueue(tx, { dedupeKey: 'rt-3', chatId: GROUP, text: 'unconfigured', threadId: null }),
    );

    const { sent, api } = recorder();
    await flush(db, api, { now: NOW });

    expect(sent[0]?.threadId).toBeNull();
  });

  it('is what an ordinary customer message looks like too', async () => {
    // Nothing about a private chat changed. A message with no topic is the
    // overwhelming majority of this table and must keep behaving as it did.
    await db.withSession((tx) => enqueue(tx, { dedupeKey: 'rt-4', chatId: 501, text: 'hi' }));

    const { sent, api } = recorder();
    await flush(db, api, { now: NOW });

    expect(sent[0]).toMatchObject({ chatId: 501, threadId: null });
  });
});
