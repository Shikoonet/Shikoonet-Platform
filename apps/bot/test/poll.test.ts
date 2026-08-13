import { describe, expect, it, vi } from 'vitest';
import { pollOnce, pruneUpdates, run } from '../src/poll.js';
import type { TelegramApi, TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 700_000 + n, telegramId: 300_000 + n };
}

function startUpdate(updateId: number, telegramId: number, text = '/start'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `poll${telegramId}` },
      chat: { id: telegramId },
      text,
    },
  };
}

/**
 * A TelegramApi with everything stubbed, so a test overrides only the one or
 * two calls it is actually about. Adding a method to the interface then costs
 * one line here instead of one per fake.
 */
function stubApi(overrides: Partial<TelegramApi> = {}): TelegramApi {
  return {
    getMe: async () => ({ username: 'Test_Shikoo_bot' }),
    getUpdates: async () => [],
    sendMessage: async () => undefined,
    editMessageText: async () => undefined,
    answerCallbackQuery: async () => undefined,
    ...overrides,
  };
}

function fakeApi(updates: TelegramUpdate[], opts: { sendFails?: boolean } = {}) {
  const sent: { chatId: number; text: string }[] = [];
  const api = stubApi({
    getUpdates: async () => updates,
    sendMessage: async (chatId, text) => {
      if (opts.sendFails) throw new Error('telegram sendMessage failed');
      sent.push({ chatId, text });
    },
  });
  return { api, sent };
}

describe('pollOnce', () => {
  it('handles the batch, replies, and advances the offset past the highest id', async () => {
    const a = ids();
    const b = ids();
    const { api, sent } = fakeApi([
      startUpdate(a.updateId, a.telegramId),
      startUpdate(b.updateId, b.telegramId),
    ]);

    const result = await pollOnce(db, api, a.updateId);

    expect(result.counts.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.offset).toBe(b.updateId + 1);
    expect(sent).toHaveLength(2);
  });

  it('leaves the offset alone when nothing arrived', async () => {
    const { api } = fakeApi([]);
    const result = await pollOnce(db, api, 4242);
    expect(result.offset).toBe(4242);
  });

  it('counts a redelivered update as a duplicate and stays quiet', async () => {
    const { updateId, telegramId } = ids();
    const first = fakeApi([startUpdate(updateId, telegramId)]);
    await pollOnce(db, first.api, updateId);

    const again = fakeApi([startUpdate(updateId, telegramId)]);
    const result = await pollOnce(db, again.api, updateId);

    expect(result.counts.duplicate).toBe(1);
    expect(again.sent).toEqual([]);
  });

  it('keeps going when one update fails, and does not claim it', async () => {
    const bad = ids();
    const good = ids();
    // Past 2^63-1, so Postgres rejects the users insert. A real database error,
    // not a mocked one — the failure path is worth testing against the thing
    // that actually produces it.
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_000;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, sent } = fakeApi([broken, startUpdate(good.updateId, good.telegramId)]);
    const result = await pollOnce(db, api, bad.updateId);
    errors.mockRestore();

    expect(result.failed).toBe(1);
    expect(result.counts.processed).toBe(1);
    // The update behind the failure was still handled.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(good.telegramId);
    // And the failed one is free to be retried on redelivery.
    const claimed = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM telegram_updates WHERE update_id = ?1`)
      .bind(bad.updateId)
      .first<{ n: number }>();
    expect(claimed?.n).toBe(0);

    // The offset is an acknowledgement: confirming past the failure would make
    // Telegram delete it, and the rollback above would have bought nothing.
    expect(result.offset).toBe(bad.updateId);
  });

  it('acknowledges nothing when every update in the batch fails', async () => {
    // What a database outage looks like. Advancing the offset here would throw
    // away the whole batch, not one message.
    const a = ids();
    const b = ids();
    const brokenA = startUpdate(a.updateId, a.telegramId);
    const brokenB = startUpdate(b.updateId, b.telegramId);
    brokenA.message!.from!.id = 9_300_000_000_000_000_000;
    brokenB.message!.from!.id = 9_300_000_000_000_000_001;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = fakeApi([brokenA, brokenB]);
    const result = await pollOnce(db, api, a.updateId);
    errors.mockRestore();

    expect(result.failed).toBe(2);
    expect(result.offset).toBe(a.updateId);
  });

  it('acknowledges the run of successes before the first failure', async () => {
    const first = ids();
    const bad = ids();
    const after = ids();
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_000;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = fakeApi([
      startUpdate(first.updateId, first.telegramId),
      broken,
      startUpdate(after.updateId, after.telegramId),
    ]);
    const result = await pollOnce(db, api, first.updateId);
    errors.mockRestore();

    // Everything up to the failure is safe to forget; the failure and what
    // follows it come back next cycle, where the claim makes the replay free.
    expect(result.offset).toBe(first.updateId + 1);
    expect(result.offset).toBeLessThanOrEqual(bad.updateId);
    expect(result.counts.processed).toBe(2);
  });

  it('treats a failed reply as a lost reply, not a failed update', async () => {
    const { updateId, telegramId } = ids();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = fakeApi([startUpdate(updateId, telegramId)], { sendFails: true });

    const result = await pollOnce(db, api, updateId);
    errors.mockRestore();

    expect(result.counts.processed).toBe(1);
    expect(result.failed).toBe(0);
    // The work committed. Retrying would change nothing, so the claim stands.
    const claimed = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM telegram_updates WHERE update_id = ?1`)
      .bind(updateId)
      .first<{ n: number }>();
    expect(claimed?.n).toBe(1);
  });
});

describe('button presses', () => {
  function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
    return {
      update_id: updateId,
      callback_query: {
        id: `cq-${updateId}`,
        from: { id: telegramId },
        message: { message_id: 77, chat: { id: telegramId } },
        data,
      },
    };
  }

  it('stops the spinner', async () => {
    const { updateId, telegramId } = ids();
    const answered: string[] = [];
    const api = stubApi({
      getUpdates: async () => [press(updateId, telegramId, 'menu')],
      answerCallbackQuery: async (id) => {
        answered.push(id);
      },
    });

    await pollOnce(db, api, updateId);

    expect(answered).toEqual([`cq-${updateId}`]);
  });

  it('stops the spinner even for a redelivered press', async () => {
    // The duplicate never reaches a handler, so answering cannot live in one.
    const { updateId, telegramId } = ids();
    const answered: string[] = [];
    const api = stubApi({
      getUpdates: async () => [press(updateId, telegramId, 'menu')],
      answerCallbackQuery: async (id) => {
        answered.push(id);
      },
    });

    await pollOnce(db, api, updateId);
    const result = await pollOnce(db, api, updateId);

    expect(result.counts.duplicate).toBe(1);
    expect(answered).toHaveLength(2);
  });

  it('replaces the menu in place instead of sending a new one', async () => {
    const { updateId, telegramId } = ids();
    // A registered customer, so the press produces a real screen.
    await pollOnce(db, fakeApi([startUpdate(updateId, telegramId)]).api, updateId);

    const edits: { messageId: number; text: string }[] = [];
    const sent: number[] = [];
    const api = stubApi({
      getUpdates: async () => [press(updateId + 1, telegramId, 'menu')],
      editMessageText: async (_chatId, messageId, text) => {
        edits.push({ messageId, text });
      },
      sendMessage: async (chatId) => {
        sent.push(chatId);
      },
    });

    await pollOnce(db, api, updateId + 1);

    expect(edits).toHaveLength(1);
    expect(edits[0]?.messageId).toBe(77);
    expect(sent).toEqual([]);
  });

  it('stops the spinner when the update failed outright', async () => {
    // Otherwise a database outage looks like a bot that hung on the button.
    const { updateId } = ids();
    const answered: string[] = [];
    const broken = press(updateId, 9_300_000_000_000_000_000, 'menu');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = stubApi({
      getUpdates: async () => [broken],
      answerCallbackQuery: async (id) => {
        answered.push(id);
      },
    });
    const result = await pollOnce(db, api, updateId);
    errors.mockRestore();

    expect(result.failed).toBe(1);
    expect(answered).toEqual([`cq-${updateId}`]);
  });
});

describe('run', () => {
  it('polls until aborted, carrying the offset forward', async () => {
    const controller = new AbortController();
    const offsets: number[] = [];
    const { updateId, telegramId } = ids();
    const api = stubApi({
      getUpdates: async (offset) => {
        offsets.push(offset);
        if (offsets.length === 1) return [startUpdate(updateId, telegramId)];
        controller.abort();
        return [];
      },
      sendMessage: async () => undefined,
    });

    await run(db, api, { signal: controller.signal, timeoutSec: 1 });

    expect(offsets[0]).toBe(0);
    // The second cycle must ask for what comes after the update it just handled.
    expect(offsets[1]).toBe(updateId + 1);
  });

  it('cancels the poll in flight rather than waiting it out', async () => {
    // A long poll blocks for 25 seconds. Without the signal reaching fetch, every
    // restart pays that in full — and a process still holding the token when the
    // next one starts is what Telegram answers with 409 to both.
    const controller = new AbortController();
    let sawSignal = false;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = stubApi({
      getUpdates: (_offset, _timeoutSec, signal) =>
        new Promise((_resolve, reject) => {
          sawSignal = signal !== undefined;
          // Resolves for no other reason: only the abort can end this.
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      sendMessage: async () => undefined,
    });

    const started = Date.now();
    const finished = run(db, api, { signal: controller.signal, timeoutSec: 25, backoffMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await finished;
    const elapsed = Date.now() - started;

    expect(sawSignal).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    // A shutdown is not an outage: it must not be logged as a failed cycle, and
    // it must not sit through the backoff on the way out.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('backs off when a batch makes no progress, instead of spinning', async () => {
    // Found by pulling the plug on Postgres for five minutes with the bot live:
    // getUpdates succeeded every time and only the handlers failed, so nothing
    // hit the catch below and nothing paused. 350 attempts, 6,000 log lines.
    const controller = new AbortController();
    const { updateId, telegramId } = ids();
    const broken = startUpdate(updateId, telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_000;

    let calls = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = stubApi({
      getUpdates: async () => {
        calls++;
        // Telegram returns instantly while updates are pending — it does not
        // long-poll — which is exactly why the loop had nothing slowing it down.
        return [broken];
      },
      sendMessage: async () => undefined,
    });

    const finished = run(db, api, { signal: controller.signal, backoffMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await finished;
    errors.mockRestore();

    // With a 10s backoff and a 150ms window, one attempt is all that fits.
    // Without the backoff this was hundreds.
    expect(calls).toBe(1);
  });

  it('survives a failed cycle instead of crash-looping', async () => {
    const controller = new AbortController();
    let calls = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = stubApi({
      getUpdates: async () => {
        calls++;
        if (calls === 1) throw new Error('telegram is down');
        controller.abort();
        return [];
      },
      sendMessage: async () => undefined,
    });

    await run(db, api, { signal: controller.signal, backoffMs: 1 });
    errors.mockRestore();

    expect(calls).toBe(2);
  });

  it('returns promptly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const api = stubApi({
      getUpdates: async () => {
        calls++;
        return [];
      },
      sendMessage: async () => undefined,
    });

    await run(db, api, { signal: controller.signal });

    expect(calls).toBe(0);
  });
});

describe('pruneUpdates', () => {
  it('drops claims older than the window and keeps the rest', async () => {
    const old = ids();
    const recent = ids();
    await db
      .prepare(
        `INSERT INTO telegram_updates (update_id, processed_at)
         VALUES (?1, now() - interval '30 days'), (?2, now())`,
      )
      .bind(old.updateId, recent.updateId)
      .run();

    const deleted = await pruneUpdates(db, 7);

    expect(deleted).toBeGreaterThanOrEqual(1);
    const survivors = await db
      .prepare(`SELECT update_id FROM telegram_updates WHERE update_id IN (?1, ?2)`)
      .bind(old.updateId, recent.updateId)
      .all<{ update_id: number }>();
    expect(survivors.results.map((r) => r.update_id)).toEqual([recent.updateId]);
  });
});
