import { describe, expect, it, vi } from 'vitest';
import { MAX_UPDATE_ATTEMPTS, pollOnce, pruneUpdates, run } from '../src/poll.js';
import type { Attempt } from '../src/poll.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 700_000 + n, telegramId: 300_000 + n };
}

/** The dead-letter row for an update, or null when there is none. */
async function deadRow(updateId: number) {
  return db
    .prepare(
      `SELECT payload, attempts, last_error FROM telegram_dead_updates WHERE update_id = ?1`,
    )
    .bind(updateId)
    .first<{ payload: TelegramUpdate; attempts: number; last_error: string | null }>();
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

  it('keeps what it gives up on, because acknowledging it is final', async () => {
    // Telegram deletes an acknowledged update and never sends it again, so the
    // drop that unblocks the queue is also the moment the message stops
    // existing. If that update was «پرداخت کردم» or a receipt, the customer's
    // action was gone and a rotated log line was the only evidence it happened.
    const bad = ids();
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_009;

    // Absent first, and this line is not ceremony. `ids()` counts from a fixed
    // base, so the same update id comes round on every run — and with the write
    // removed this test still passed on a row the PREVIOUS run had left behind.
    // The table is truncated between runs now; this says so out loud.
    expect(await deadRow(bad.updateId)).toBeNull();

    const attempts = new Map<number, Attempt>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let last;
    for (let cycle = 0; cycle < MAX_UPDATE_ATTEMPTS + 1; cycle++) {
      const { api } = fakeApi([broken]);
      last = await pollOnce(db, api, bad.updateId, 25, undefined, attempts);
    }
    errors.mockRestore();

    expect(last?.abandoned).toBe(1);
    const dead = await deadRow(bad.updateId);

    expect(dead).not.toBeNull();
    expect(dead?.attempts).toBe(MAX_UPDATE_ATTEMPTS);
    // The whole update, not a summary of it: the point is that a person can see
    // what was lost and act on it by hand.
    expect(dead?.payload.message?.from?.id).toBe(9_300_000_000_000_000_009);
    expect(dead?.payload.update_id).toBe(bad.updateId);
    // And why it died, which is the half that only exists at the moment of the
    // failure — a cycle before the drop.
    expect(dead?.last_error ?? '').not.toBe('');
  });

  it('holds the update when it cannot be kept, and lets it go once it can', async () => {
    // This asserted the opposite until 2026-08-21: dropped anyway, on the
    // argument that refusing would put the queue back behind a poison update.
    //
    // The argument does not survive asking WHEN this branch is reachable. Three
    // failures accumulate on a single-update batch, which on a quiet bot is a
    // database outage — and a database outage is also what makes this insert
    // fail. The two conditions are usually the same event, and what was thrown
    // away is whatever a customer sent during it, which in this bot is
    // «پرداخت کردم» or a receipt.
    //
    // The freeze that replaces it is bounded by the outage: nothing could have
    // been processed during it anyway, and the moment the table is reachable
    // the update drops and the queue moves. Both halves are asserted here,
    // against the table really being taken away rather than a stub.
    const bad = ids();
    const good = ids();
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_010;

    const attempts = new Map<number, Attempt>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let last;
    await db.prepare(`ALTER TABLE telegram_dead_updates RENAME TO dead_hidden`).run();
    try {
      for (let cycle = 0; cycle < MAX_UPDATE_ATTEMPTS + 1; cycle++) {
        const { api } = fakeApi([broken, startUpdate(good.updateId, good.telegramId)]);
        last = await pollOnce(db, api, bad.updateId, 25, undefined, attempts);
      }

      // Held. The offset has not moved past it, so Telegram still has the
      // payload and will hand it back.
      expect(last?.abandoned).toBe(0);
      expect(last?.offset).toBe(bad.updateId);
    } finally {
      await db.prepare(`ALTER TABLE dead_hidden RENAME TO telegram_dead_updates`).run();
    }

    // The outage ends. One more cycle and the update is recorded, dropped, and
    // everything behind it moves — no restart, no human, no lost payload.
    const { api } = fakeApi([broken, startUpdate(good.updateId, good.telegramId)]);
    last = await pollOnce(db, api, bad.updateId, 25, undefined, attempts);
    errors.mockRestore();

    expect(last?.abandoned).toBe(1);
    expect(last?.offset).toBe(good.updateId + 1);
    expect((await deadRow(bad.updateId))?.payload.message?.from?.id).toBe(
      9_300_000_000_000_000_010,
    );
  });

  it('gives up on a poison update and unblocks everything behind it', async () => {
    // The outage this closes: the offset never advances past an update that
    // always throws, so no later update is ever acknowledged and the same batch
    // is handed back for ever. One customer stops the bot for everybody.
    const bad = ids();
    const good = ids();
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_002;

    const attempts = new Map<number, Attempt>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // A healthy batch each cycle: the poison update fails, the other succeeds.
    // Redelivery is what a blocked offset produces, so the same pair comes back.
    let last;
    for (let cycle = 0; cycle < MAX_UPDATE_ATTEMPTS + 1; cycle++) {
      const { api } = fakeApi([broken, startUpdate(good.updateId, good.telegramId)]);
      last = await pollOnce(db, api, bad.updateId, 25, undefined, attempts);
    }
    errors.mockRestore();

    expect(last?.abandoned).toBe(1);
    // Past the poison update AND past the good one behind it — the queue moves.
    expect(last?.offset).toBe(good.updateId + 1);
  });

  it('does not spend a poison update budget on a database outage', async () => {
    // Every update failing is an outage, not a poison update. Counting those
    // would drop a whole batch of real customer messages after three cycles of
    // a database being down — the exact loss the old comment refused to accept.
    const a = ids();
    const b = ids();
    const brokenA = startUpdate(a.updateId, a.telegramId);
    const brokenB = startUpdate(b.updateId, b.telegramId);
    brokenA.message!.from!.id = 9_300_000_000_000_000_003;
    brokenB.message!.from!.id = 9_300_000_000_000_000_004;

    const attempts = new Map<number, Attempt>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let cycle = 0; cycle < MAX_UPDATE_ATTEMPTS + 2; cycle++) {
      const { api } = fakeApi([brokenA, brokenB]);
      const result = await pollOnce(db, api, a.updateId, 25, undefined, attempts);
      // Never abandoned, however long the outage lasts, and never acknowledged.
      expect(result.abandoned).toBe(0);
      expect(result.offset).toBe(a.updateId);
    }
    errors.mockRestore();
    expect(attempts.size).toBe(0);
  });

  it('still gives up on a poison update that arrives alone', async () => {
    // The hole the outage rule left behind. "Every update failed" is evidence
    // of an outage only when there were several to fail; in a batch of one it
    // is the same observation for both causes and carries no information at
    // all. Forgiving it anyway meant the counter was wiped every cycle, so
    // MAX_UPDATE_ATTEMPTS was never reached and a quiet bot — nights, which is
    // most of them — froze on one bad press exactly as it did before M3.
    const bad = ids();
    const broken = startUpdate(bad.updateId, bad.telegramId);
    broken.message!.from!.id = 9_300_000_000_000_000_005;

    const attempts = new Map<number, Attempt>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let last;
    for (let cycle = 0; cycle < MAX_UPDATE_ATTEMPTS + 1; cycle++) {
      const { api } = fakeApi([broken]);
      last = await pollOnce(db, api, bad.updateId, 25, undefined, attempts);
    }
    errors.mockRestore();

    expect(last?.abandoned).toBe(1);
    expect(last?.offset).toBe(bad.updateId + 1);
  });

  it('forgets a failure once the same update succeeds', async () => {
    // A transient fault must not leave a mark that a later, unrelated failure
    // can add to and tip over the edge.
    const { updateId, telegramId } = ids();
    const attempts = new Map<number, Attempt>([[updateId, { count: MAX_UPDATE_ATTEMPTS - 1, lastError: 'a transient fault' }]]);
    const { api } = fakeApi([startUpdate(updateId, telegramId)]);

    const result = await pollOnce(db, api, updateId, 25, undefined, attempts);

    expect(result.counts.processed).toBe(1);
    expect(attempts.has(updateId)).toBe(false);
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


/**
 * The QR button, and the link underneath it.
 *
 * Nothing on the reply path is retried: the transaction has committed and
 * re-fetching the update would be a no-op against the claim, so a reply that
 * throws is lost and said to be lost. That is tolerable for navigation. It was
 * not tolerable for this one, because the reply IS the customer's subscription
 * address — a picture Telegram refused took the address with it and left a
 * button that did nothing.
 */
describe('a reply that carries a picture', () => {
  async function serviceFor(telegramId: number, url: string): Promise<number> {
    const userId = await makeCustomer(telegramId);
    const row = await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, plan_name_at_sale, price_irr, remote_username,
            subscription_url, status, purchased_at)
         VALUES (?1, ?2, 'یک‌ماهه', 1950000, 'u_qr', ?3, 'ACTIVE', now())
         RETURNING id`,
      )
      .bind(`qr${telegramId}`, userId, url)
      .first<{ id: number }>();
    return row!.id;
  }

  it('sends the link as text when the picture cannot be sent', async () => {
    const { updateId, telegramId } = ids();
    const url = 'https://panel.example/sub/qr-fallback-token';
    const subscriptionId = await serviceFor(telegramId, url);

    const press: TelegramUpdate = {
      update_id: updateId,
      callback_query: {
        id: `cq-${updateId}`,
        from: { id: telegramId, username: `poll${telegramId}` },
        message: { message_id: 5, chat: { id: telegramId } },
        data: `qr:${subscriptionId}`,
      },
    };
    const sent: { chatId: number; text: string }[] = [];
    const api = stubApi({
      getUpdates: async () => [press],
      sendPhotoBytes: async () => {
        throw new Error('telegram sendPhoto failed: 400 PHOTO_INVALID_DIMENSIONS');
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    await pollOnce(db, api, updateId);

    expect(sent).toEqual([{ chatId: telegramId, text: url }]);
  });
});
