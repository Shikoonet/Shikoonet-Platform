/**
 * One bot, one rate limit, two queues (#364).
 *
 * The broadcast sweep and the outbox drain each talked to Telegram as if they
 * were alone: the sweep paced itself and sat out its own 429s, and a receipt
 * from the outbox went into the middle of that ban and lengthened it. And the
 * pause lived inside one sweep, so the container that came back after a
 * promote sent at once into whatever ban the previous one had been serving.
 *
 * What these tests pin, each against a clock rather than against the code:
 *
 *   - an outbox message goes at once and TAKES the broadcast's next slot —
 *     the announcement pauses one gap and carries on, nothing fails;
 *   - a 429 met by either loop holds the other;
 *   - the pause survives the process, through `settings`;
 *   - a sweep killed mid-batch leaves nothing stranded and the next process
 *     finishes the broadcast with every customer told exactly once.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';
import { sweepBroadcasts } from '../src/poll.js';
import { enqueue, flush } from '../src/notify.js';
import { loadPause, pace, pauseFor, resetPace } from '../src/pace.js';
import { TelegramRejection } from '../src/telegram.js';

const GAP_MS = 300;
process.env['BROADCAST_SEND_GAP_MS'] = String(GAP_MS);

let seq = 0;
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** A text broadcast with `count` recipients, all PENDING. */
async function queueBroadcast(count: number): Promise<{ id: string; chats: number[] }> {
  const id = uuid();
  seq += 1;
  await db
    .prepare(`INSERT INTO broadcasts (id, body, created_by) VALUES (?1, 'اطلاعیه', 111)`)
    .bind(id)
    .run();
  const chats: number[] = [];
  for (let i = 0; i < count; i++) {
    const telegramId = 790_000_000 + seq * 1000 + i;
    const userId = await makeCustomer(telegramId);
    chats.push(telegramId);
    await db
      .prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id, status)
         VALUES (?1, ?2, ?3, 'PENDING')`,
      )
      .bind(id, userId, telegramId)
      .run();
  }
  return { id, chats };
}

/** One direct message in the outbox, the way the panel writes it. */
async function queueDirect(chatId: number): Promise<void> {
  const queued = await db.withSession((tx) =>
    enqueue(tx, { dedupeKey: `direct:${uuid()}`, chatId, text: 'جواب پشتیبانی' }),
  );
  expect(queued).toBe(true);
}

async function statusCounts(id: string): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT status, count(*)::int AS n FROM broadcast_recipients
        WHERE broadcast_id = ?1 GROUP BY status`,
    )
    .bind(id)
    .all<{ status: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.status, r.n]));
}

const tooFast = (sec: number) =>
  new TelegramRejection('telegram sendMessage rejected: Too Many Requests', 429, sec);

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  await db.prepare(`DELETE FROM broadcast_recipients`).run();
  await db.prepare(`DELETE FROM broadcasts`).run();
});

describe('a direct message during a broadcast', () => {
  it('goes at once, and the broadcast pauses one slot rather than stopping', async () => {
    const { chats } = await queueBroadcast(3);
    const direct = 799_000_001;
    await queueDirect(direct);
    const sends: { chat: number; at: number }[] = [];
    const api = stubApi({
      sendMessage: async (chat) => {
        sends.push({ chat, at: Date.now() });
        return { messageId: null };
      },
    });

    // The sweep starts first and reserves its slots; the outbox drains beside
    // it, the way the two loops run in the bot.
    const sweep = sweepBroadcasts(db, api);
    await new Promise((r) => setTimeout(r, GAP_MS / 2));
    const startedFlush = Date.now();
    await flush(db, api);
    await sweep;

    const directSend = sends.find((s) => s.chat === direct);
    // The outbox did not wait for a slot.
    expect(directSend).toBeDefined();
    expect(directSend!.at - startedFlush).toBeLessThan(GAP_MS);
    // The broadcast's sends AFTER it are a full gap away from it — it took
    // the slot they would have had — and every one of them still went.
    const after = sends.filter((s) => s.chat !== direct && s.at > directSend!.at);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s.at - directSend!.at).toBeGreaterThanOrEqual(GAP_MS - 20);
    expect(sends.filter((s) => chats.includes(s.chat)).length).toBe(3);
  });
});

describe('a 429, wherever it lands', () => {
  it('met by the outbox holds the broadcast', async () => {
    const { id } = await queueBroadcast(1);
    await queueDirect(799_000_002);
    let first = true;
    const at: number[] = [];
    const api = stubApi({
      sendMessage: async () => {
        at.push(Date.now());
        if (first) {
          first = false;
          throw tooFast(1);
        }
        return { messageId: null };
      },
    });

    await flush(db, api);
    const paused = Date.now();
    await sweepBroadcasts(db, api);

    expect(at.length).toBe(2);
    expect(at[1]! - paused).toBeGreaterThanOrEqual(900);
    expect((await statusCounts(id))['SENT']).toBe(1);
  });

  it('met by the broadcast holds the outbox, without burning an attempt', async () => {
    await queueBroadcast(1);
    await queueDirect(799_000_003);
    let calls = 0;
    const api = stubApi({
      sendMessage: async () => {
        calls += 1;
        throw tooFast(30);
      },
    });

    await sweepBroadcasts(db, api);
    const r = await flush(db, api);

    expect(calls).toBe(1);
    expect(r).toEqual({ sent: 0, failed: 0, dead: 0 });
    const row = await db
      .prepare(`SELECT attempt_count FROM bot_notifications WHERE chat_id = 799000003`)
      .first<{ attempt_count: number }>();
    expect(Number(row?.attempt_count)).toBe(0);
  });

  it('outlives the process', async () => {
    // The previous container was told to wait; this one reads it before its
    // first send. Without the row, the promote on 2026-09-17 would have sent
    // straight into the ban and extended it.
    await pauseFor(db, 1_000);
    await new Promise((r) => setTimeout(r, 50));
    const recorded = pace.pauseUntil;
    resetPace();
    expect(pace.pauseUntil).toBe(0);

    await loadPause(db);
    expect(pace.pauseUntil).toBe(recorded);

    const { id } = await queueBroadcast(1);
    const started = Date.now();
    let sentAt = 0;
    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          sentAt = Date.now();
          return { messageId: null };
        },
      }),
    );
    expect(sentAt - started).toBeGreaterThanOrEqual(recorded - started - 20);
    expect((await statusCounts(id))['SENT']).toBe(1);
  });
});

describe('a broadcast across a restart', () => {
  it('is finished by the next process, every customer told exactly once', async () => {
    const { id, chats } = await queueBroadcast(8);
    const sent: number[] = [];
    const controller = new AbortController();
    const first = stubApi({
      sendMessage: async (chat) => {
        sent.push(chat);
        // The signal comes mid-batch, as SIGTERM does.
        if (sent.length === 2) controller.abort();
        return { messageId: null };
      },
    });
    await sweepBroadcasts(db, first, controller.signal, 8);

    // Between the two processes: what went is SENT, the rest is nobody's,
    // and the two add up to the whole broadcast.
    const between = await statusCounts(id);
    expect(between['SENDING']).toBeUndefined();
    expect((between['SENT'] ?? 0) + (between['PENDING'] ?? 0)).toBe(8);
    expect(between['SENT']).toBe(sent.length);

    // The second process knows nothing and needs to know nothing — including
    // the pace the first one had in memory, which a restart does not keep.
    resetPace();
    const second = stubApi({
      sendMessage: async (chat) => {
        sent.push(chat);
        return { messageId: null };
      },
    });
    await sweepBroadcasts(db, second, undefined, 8);

    expect(await statusCounts(id)).toEqual({ SENT: 8 });
    expect([...sent].sort()).toEqual([...chats].sort());
  });
});
