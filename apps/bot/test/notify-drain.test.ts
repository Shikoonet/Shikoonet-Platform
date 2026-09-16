/**
 * The outbox is sent beside the poll loop, not at the bottom of it.
 *
 * 2026-09-16, production: an import put ten thousand rows in
 * `bot_notifications`, `notify.flush` ran once per cycle with fifty of them,
 * and every customer's every press waited the forty seconds that took. The
 * loop below is the fix; these are the two things it has to keep true.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { drainNotifications } from '../src/poll.js';
import { enqueue } from '../src/notify.js';
import { TelegramRejection } from '../src/telegram.js';

let seq = 0;

async function queueNotes(count: number): Promise<void> {
  seq += 1;
  for (let i = 0; i < count; i++) {
    const queued = await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: `drain-test:${seq}:${i}`,
        chatId: 800_000_000 + seq * 1000 + i,
        text: 'سلام',
      }),
    );
    expect(queued).toBe(true);
  }
}

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'drain-test:%'`).run();
});

describe('the outbox, drained', () => {
  it('sends batch after batch without a poll cycle and without idling between them', async () => {
    // Five rows through batches of two: three claims in a row, no sleep
    // between them. Counted by the idle gap's own duration rather than by the
    // clock, as `broadcast-speed.test.ts` does — a loop that slept after every
    // batch would show two such sleeps whatever the machine's speed.
    await queueNotes(5);
    const controller = new AbortController();
    let sent = 0;
    const api = stubApi({
      sendMessage: async () => {
        sent += 1;
        if (sent === 5) controller.abort();
      },
    });

    const sleeps = vi.spyOn(globalThis, 'setTimeout');
    await drainNotifications(db, api, controller.signal, { limit: 2, idleMs: 2_000 });
    const idled = sleeps.mock.calls.filter(([, ms]) => ms === 2_000).length;
    sleeps.mockRestore();

    expect(sent).toBe(5);
    expect(idled).toBe(0);
    const left = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM bot_notifications
          WHERE dedupe_key LIKE 'drain-test:%' AND status <> 'SENT'`,
      )
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('keeps going through a batch that all died, rather than sleeping after it', async () => {
    // The production shape: fifty «chat not found» in a row. Dead rows are
    // work done, and the next batch must follow at once — otherwise a queue
    // of ten thousand unreachable customers drains at fifty a second.
    await queueNotes(4);
    const controller = new AbortController();
    let tried = 0;
    const api = stubApi({
      sendMessage: async () => {
        tried += 1;
        if (tried === 4) controller.abort();
        throw new TelegramRejection('telegram sendMessage rejected: Bad Request: chat not found', 400);
      },
    });

    const sleeps = vi.spyOn(globalThis, 'setTimeout');
    await drainNotifications(db, api, controller.signal, { limit: 2, idleMs: 2_000 });
    const idled = sleeps.mock.calls.filter(([, ms]) => ms === 2_000).length;
    sleeps.mockRestore();

    expect(tried).toBe(4);
    expect(idled).toBe(0);
  });
});
