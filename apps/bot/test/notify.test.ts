/**
 * The outbox that stopped messages being lost.
 *
 * Before this, a sweep advanced its rows, returned the messages, and `poll.ts`
 * sent them — and a `sendMessage` that threw was logged and gone, because
 * nothing would ever produce it again. Telegram refusing for ten seconds is
 * ordinary; a customer who paid and was never told is not.
 *
 * What each half owes is different, and the tests are split accordingly:
 * `enqueue` owes durability inside the caller's transaction, and `flush` owes
 * delivery — eventually, without duplicates, and without retrying somebody who
 * can never be reached.
 *
 * Needs DATABASE_URL (`pnpm sim:up`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueue, flush, LEASE_MS, MAX_ATTEMPTS, nextAttemptDelayMs } from '../src/notify.js';
import { MAX_COPY_TEXT_LENGTH, TelegramRejection, type TelegramApi } from '../src/telegram.js';
import * as menu from '../src/menu.js';
import { db } from './helpers/env.js';

const NOW = 1_786_000_000_000;
const CHAT = 55_500_001;

/** Only the one method the outbox uses. */
function apiThat(send: (chatId: number, text: string) => Promise<unknown>): TelegramApi {
  return { sendMessage: send } as unknown as TelegramApi;
}

const ok = (): TelegramApi => apiThat(() => Promise.resolve({}));

async function rowOf(key: string): Promise<{
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  sent_at: string | null;
}> {
  const r = await db
    .prepare(
      `SELECT status, attempt_count, next_attempt_at, last_error, sent_at::text AS sent_at
         FROM bot_notifications WHERE dedupe_key = ?1`,
    )
    .bind(key)
    .first<{
      status: string;
      attempt_count: number;
      next_attempt_at: number | null;
      last_error: string | null;
      sent_at: string | null;
    }>();
  if (!r) throw new Error(`no notification ${key}`);
  return r;
}

async function put(key: string, text = 'hello'): Promise<void> {
  await db.withSession((tx) => enqueue(tx, { dedupeKey: key, chatId: CHAT, text }));
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM bot_notifications`).run();
  vi.restoreAllMocks();
});

describe('owing a customer a message', () => {
  it('survives the transaction that wrote it', async () => {
    await put('k1');
    expect(await rowOf('k1')).toMatchObject({ status: 'PENDING', attempt_count: 0 });
  });

  it('is not written twice for one event', async () => {
    // The dedupe key is what replaces the old "send it inline and never retry"
    // trade: a producer may run again freely, and the customer still hears once.
    await put('k2', 'first');
    await put('k2', 'second');

    const { results } = await db
      .prepare(`SELECT body FROM bot_notifications WHERE dedupe_key = 'k2'`)
      .all<{ body: string }>();
    expect(results).toHaveLength(1);
    // The first text wins. A later producer must not overwrite a message that
    // may already be on its way.
    expect(results[0]?.body).toBe('first');
  });

  it('vanishes with the transaction if that rolls back', async () => {
    // The whole reason `enqueue` takes a `tx` rather than the database. A
    // message owed for a settlement that did not happen is worse than none.
    await expect(
      db.withSession(async (tx) => {
        await enqueue(tx, { dedupeKey: 'k3', chatId: CHAT, text: 'never' });
        throw new Error('the caller changed its mind');
      }),
    ).rejects.toThrow('changed its mind');

    const n = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM bot_notifications WHERE dedupe_key = 'k3'`)
      .first<number>('n');
    expect(n).toBe(0);
  });
});

describe('delivering it', () => {
  it('sends what is due and marks it sent', async () => {
    await put('d1', 'your payment is confirmed');
    const sent: [number, string][] = [];

    const res = await flush(
      db,
      apiThat((c, t) => {
        sent.push([c, t]);
        return Promise.resolve({});
      }),
      {
        now: NOW,
      },
    );

    expect(res).toMatchObject({ sent: 1, failed: 0, dead: 0 });
    expect(sent).toEqual([[CHAT, 'your payment is confirmed']]);
    const row = await rowOf('d1');
    expect(row.status).toBe('SENT');
    expect(row.sent_at).not.toBeNull();
    // Cleared, not left at the lease the claim wrote — a SENT row with a future
    // due date would be swept for ever.
    expect(row.next_attempt_at).toBeNull();
  });

  it('claims no more than the limit it was given', async () => {
    // The third statement of this shape checked on 2026-08-19, after the first
    // two were found broken: `claimBroadcastBatch` handed back a whole
    // broadcast for a limit of one, and the webhook outbox handed back eight
    // for a limit of three. The planner is free to turn an uncorrelated
    // subquery into a per-row SubPlan, and then the limit bounds each
    // execution rather than the batch.
    let delivered = 0;
    for (let i = 0; i < 8; i++) await put(`lim${i}`);

    const res = await flush(
      db,
      apiThat(() => {
        delivered += 1;
        return Promise.resolve({});
      }),
      { now: NOW, limit: 3 },
    );

    expect(res.sent).toBe(3);
    expect(delivered).toBe(3);
    const left = await db
      .prepare(`SELECT count(*)::int AS n FROM bot_notifications WHERE status = 'PENDING'`)
      .first<{ n: number }>();
    expect(left?.n).toBe(5);
  });

  it('keeps a message Telegram would not take, and schedules a retry', async () => {
    await put('d2');

    const res = await flush(
      db,
      apiThat(() => Promise.reject(new TelegramRejection('telegram is unwell', 500))),
      { now: NOW },
    );

    expect(res).toMatchObject({ sent: 0, failed: 1, dead: 0 });
    const row = await rowOf('d2');
    expect(row.status).toBe('FAILED');
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).toBe(NOW + nextAttemptDelayMs(1));
    expect(row.last_error).toContain('unwell');
  });

  it('eventually delivers a message the first attempt lost', async () => {
    // The whole point, stated as one test: a refusal now is not a lost message.
    await put('d3');
    await flush(
      db,
      apiThat(() => Promise.reject(new Error('network'))),
      { now: NOW },
    );
    expect((await rowOf('d3')).status).toBe('FAILED');

    const later = NOW + nextAttemptDelayMs(1);
    const res = await flush(db, ok(), { now: later });

    expect(res).toMatchObject({ sent: 1 });
    expect((await rowOf('d3')).status).toBe('SENT');
  });

  it('does not retry before the backoff has elapsed', async () => {
    await put('d4');
    await flush(
      db,
      apiThat(() => Promise.reject(new Error('network'))),
      { now: NOW },
    );

    let calls = 0;
    const res = await flush(
      db,
      apiThat(() => {
        calls += 1;
        return Promise.resolve({});
      }),
      {
        now: NOW + 1_000,
      },
    );

    expect(res.sent).toBe(0);
    expect(calls).toBe(0);
  });

  it('gives up immediately on a customer who blocked the bot', async () => {
    // 403 will still be 403 in an hour. Spending eight attempts on it is eight
    // attempts not spent on somebody who can still be reached.
    await put('d5');

    const res = await flush(
      db,
      apiThat(() => Promise.reject(new TelegramRejection('bot was blocked by the user', 403))),
      { now: NOW },
    );

    expect(res).toMatchObject({ dead: 1, failed: 0 });
    const row = await rowOf('d5');
    expect(row.status).toBe('DEAD');
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).toBeNull();
  });

  it('retries a 429 rather than giving up on it', async () => {
    // The mirror of the case above, and the reason the code reads the numeric
    // code instead of matching on the description text.
    await put('d6');

    const res = await flush(
      db,
      apiThat(() => Promise.reject(new TelegramRejection('Too Many Requests', 429))),
      { now: NOW },
    );

    expect(res).toMatchObject({ failed: 1, dead: 0 });
    expect((await rowOf('d6')).status).toBe('FAILED');
  });

  it('stops after the last attempt instead of trying for ever', async () => {
    await db
      .prepare(
        `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status, attempt_count)
         VALUES ('d7', ?1, 'x', 'FAILED', ?2)`,
      )
      .bind(CHAT, MAX_ATTEMPTS - 1)
      .run();

    const res = await flush(
      db,
      apiThat(() => Promise.reject(new Error('still down'))),
      {
        now: NOW,
      },
    );

    expect(res).toMatchObject({ dead: 1 });
    const row = await rowOf('d7');
    expect(row.status).toBe('DEAD');
    expect(row.attempt_count).toBe(MAX_ATTEMPTS);
  });

  it('claims a message before sending it, so a second sweep skips it', async () => {
    // The guard is the lease the claiming UPDATE writes, not the SKIP LOCKED
    // beside it: outside an explicit transaction a plain SELECT ... FOR UPDATE
    // releases its lock before the caller has read anything.
    await put('d8');
    let inner = { sent: -1 };

    await flush(
      db,
      apiThat(async () => {
        inner = await flush(db, ok(), { now: NOW });
        return {};
      }),
      { now: NOW },
    );

    expect(inner.sent).toBe(0);
    expect((await rowOf('d8')).status).toBe('SENT');
  });

  it('hands back a message whose sweeper died, once the lease expires', async () => {
    await put('d9');
    // A sweeper that claimed the row and never came back: the claim committed,
    // the verdict never did.
    await db
      .prepare(
        `UPDATE bot_notifications SET attempt_count = 1, next_attempt_at = ?1
          WHERE dedupe_key = 'd9'`,
      )
      .bind(NOW + LEASE_MS)
      .run();

    expect((await flush(db, ok(), { now: NOW })).sent).toBe(0);
    expect((await flush(db, ok(), { now: NOW + LEASE_MS })).sent).toBe(1);
  });

  it('never throws, whatever Telegram does', async () => {
    // It is called from the poll loop. A bot that stopped answering because one
    // message would not send would be worse than the bug this file fixes.
    await put('d10');
    await expect(
      flush(
        db,
        apiThat(() => Promise.reject(new Error('boom'))),
        { now: NOW },
      ),
    ).resolves.toMatchObject({ failed: 1 });
  });
});

describe('the backoff', () => {
  it('doubles from a minute and stops at an hour', () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000);
    expect(nextAttemptDelayMs(2)).toBe(120_000);
    expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBe(3_600_000);
  });
});

/**
 * A delivery message is no longer a line of text: it carries the buttons of the
 * service screen and a QR code of the subscription link. Both travel in the
 * row, because the row IS the message — a keyboard rebuilt at send time could
 * disagree with the text it sits under.
 */
describe('what a message carries besides its text', () => {
  interface Sent {
    kind: 'text' | 'photo';
    body: string;
    keyboard?: unknown;
  }

  /** Records both calls in the order Telegram would see them. */
  function recorder(opts: { textFails?: boolean; photoFails?: boolean } = {}): {
    api: TelegramApi;
    sent: Sent[];
  } {
    const sent: Sent[] = [];
    const api = {
      sendMessage: async (_chat: number, text: string, keyboard?: unknown) => {
        sent.push({ kind: 'text', body: text, keyboard });
        if (opts.textFails) throw new Error('telegram sendMessage failed: boom');
      },
      sendPhotoBytes: async (_chat: number, png: Uint8Array) => {
        if (opts.photoFails)
          throw new Error('telegram sendPhoto failed: 400 PHOTO_INVALID_DIMENSIONS');
        sent.push({ kind: 'photo', body: `png:${png.byteLength}` });
      },
    } as unknown as TelegramApi;
    return { api, sent };
  }

  const KEYBOARD = [[{ text: '📷 دریافت QR Code', callback_data: 'qr:7' }]];

  it('sends the picture first, then the text with its buttons', async () => {
    await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: 'q1',
        chatId: CHAT,
        text: 'service',
        keyboard: KEYBOARD,
        qrPayload: 'https://panel.example/sub/abc',
      }),
    );
    const { api, sent } = recorder();
    expect((await flush(db, api, { now: NOW })).sent).toBe(1);

    expect(sent.map((s) => s.kind)).toEqual(['photo', 'text']);
    expect(sent[1]?.keyboard).toEqual(KEYBOARD);
    expect(await rowOf('q1')).toMatchObject({ status: 'SENT' });
  });

  it('sends the text even when the picture cannot be sent', async () => {
    // The picture is a decoration; the text is the product, and it carries the
    // same link in full. Awaited ahead of `sendMessage` with nothing between
    // them, anything that made the photo call fail — Telegram refusing a photo
    // with 400, a flood wait, a payload past the encoder's capacity — took the
    // message with it through all eight attempts until the row was DEAD, and a
    // customer who had paid never received their config.
    await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: 'q-photo-fails',
        chatId: CHAT,
        text: 'https://panel.example/sub/abc',
        keyboard: KEYBOARD,
        qrPayload: 'https://panel.example/sub/abc',
      }),
    );
    const { api, sent } = recorder({ photoFails: true });

    expect((await flush(db, api, { now: NOW })).sent).toBe(1);
    expect(sent.map((s) => s.kind)).toEqual(['text']);
    expect(await rowOf('q-photo-fails')).toMatchObject({ status: 'SENT' });
  });

  it('tries the picture again on a retry, because nothing was sent', async () => {
    // The mark is written on success only. A QR that failed was not delivered,
    // so the attempt that carries the text should carry the picture too.
    await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: 'q-photo-retry',
        chatId: CHAT,
        text: 'service',
        qrPayload: 'https://panel.example/sub/abc',
      }),
    );
    await flush(db, recorder({ photoFails: true, textFails: true }).api, { now: NOW });

    const retry = recorder();
    await flush(db, retry.api, { now: NOW + LEASE_MS + nextAttemptDelayMs(1) });
    expect(retry.sent.map((s) => s.kind)).toEqual(['photo', 'text']);
  });

  it('does not send the picture again when the text has to be retried', async () => {
    // The two are separate Telegram calls and only the second one is retried by
    // the row failing. Without the mark this customer gets a second QR on every
    // attempt — up to eight of them.
    await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: 'q2',
        chatId: CHAT,
        text: 'service',
        qrPayload: 'https://panel.example/sub/abc',
      }),
    );
    const failing = recorder({ textFails: true });
    await flush(db, failing.api, { now: NOW });
    expect(failing.sent.filter((s) => s.kind === 'photo')).toHaveLength(1);

    const retry = recorder();
    await flush(db, retry.api, { now: NOW + LEASE_MS + nextAttemptDelayMs(1) });
    expect(retry.sent.map((s) => s.kind)).toEqual(['text']);
  });

  it('leaves an ordinary message exactly as it was', async () => {
    // Every notice that is not a delivery still goes as one plain sendMessage.
    await put('q3');
    const { api, sent } = recorder();
    await flush(db, api, { now: NOW });
    expect(sent).toEqual([{ kind: 'text', body: 'hello', keyboard: undefined }]);
  });
});

/**
 * The link a customer has to get into another app.
 *
 * Telegram's monospace is tap-to-copy, and this file sets no `parse_mode`
 * anywhere on purpose — so the same affordance has to be a `copy_text` button,
 * the one the checkout already uses for the card number.
 */
describe('copying the subscription link', () => {
  it('offers a copy button carrying the link exactly', () => {
    const url = 'https://pasa.fallumi.ir/sub/djMsOSwxNzg3MTM1MjE1.JPOI1ANZmAbZ2xDGHPEG';
    const rows = menu.copyLinkMenu(url);
    expect(rows?.[0]?.[0]?.copy_text).toEqual({ text: url });
  });

  it('offers none for a link Telegram would truncate', () => {
    // A button that silently copies half a URL is worse than no button: the
    // customer pastes it, the import fails, and nothing said why.
    expect(menu.copyLinkMenu(`https://x/${'a'.repeat(MAX_COPY_TEXT_LENGTH)}`)).toBeUndefined();
  });
});
