/**
 * Sending a broadcast: the pace, the pool, and the thing neither may break.
 *
 * The loop was serial — send, wait 40ms, send — and the 40ms was written as if
 * it were the limit. It never was: a round trip to Telegram from here is 200ms
 * and up, so each message cost latency + gap and the process spent nine tenths
 * of a broadcast waiting. Sending several at once is what removes that, and
 * these tests are the three things that have to stay true while it does.
 *
 * The measurements use fake timers rather than a real clock. A test that
 * asserted "under a second" would be asserting the speed of this laptop, and it
 * would be the flakiest thing in the suite the first time CI was busy.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';
import { drainBroadcasts, sweepBroadcasts } from '../src/poll.js';
import { SEND_CONCURRENCY } from '../src/broadcast.js';

/**
 * How long a send takes in these tests.
 *
 * Deliberately LONGER than `SEND_GAP_MS`, because that is the only condition
 * under which the pool does anything: when a round trip is shorter than the
 * pace, the pace alone spaces the sends out and nothing ever overlaps. A first
 * draft used 30ms here and measured a peak of exactly one — correct behaviour,
 * and a test that proved nothing about the change.
 *
 * 200ms is also the real number: a round trip to Telegram from Iran is 200ms
 * and up, which is what made the old serial loop four messages a second.
 */
const ROUND_TRIP_MS = 200;

let seq = 0;

/**
 * A broadcast with `count` recipients, all PENDING.
 *
 * `id` is a uuid and `created_by` a telegram id, both because the columns say
 * so — a fixture that invented its own shapes would be testing a table this
 * product does not have.
 */
async function queueBroadcast(count: number): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await db
    .prepare(`INSERT INTO broadcasts (id, body, created_by) VALUES (?1, 'سلام', 111)`)
    .bind(id)
    .run();
  for (let i = 0; i < count; i++) {
    const telegramId = 700_000_000 + seq * 1000 + i;
    // The suite's own customer fixture, rather than a hand-written INSERT: the
    // table has columns this file has no business knowing about, and the first
    // attempt here failed on one of them.
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

describe('a broadcast, sent', () => {
  it('overlaps its sends instead of waiting out each round trip', async () => {
    // The property, not the clock. An earlier version of this test used fake
    // timers to assert an elapsed-time bound; fake timers and a real Postgres do
    // not mix — the DB promises never settle inside `runAllTimersAsync` — and a
    // real-clock bound would have been asserting the speed of this laptop.
    //
    // What actually changed is that sends OVERLAP. That is observable directly,
    // it is the thing the wall-clock improvement follows from, and it cannot go
    // green on a fast machine while the pool is broken.
    const id = await queueBroadcast(12);
    let inFlight = 0;
    let peak = 0;

    const api = stubApi({
      sendMessage: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ROUND_TRIP_MS));
        inFlight -= 1;
        return { messageId: null };
      },
    });

    const sent = await sweepBroadcasts(db, api);

    expect(sent).toBe(12);
    expect(peak).toBeGreaterThan(1);
    // Four in flight at 200ms against a 50ms pace, so «more than one»
    // is a floor with room under it rather than a coin flip.
    // Nothing left behind: overlapping must not lose a recipient.
    const pending = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 AND status <> 'SENT'`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it('never has more sends in flight than the pool allows', async () => {
    // The other half of the pace. Unbounded parallelism would be two hundred
    // sockets and a 429 from Telegram, which costs the whole broadcast rather
    // than the few seconds it saved.
    await queueBroadcast(24);
    let inFlight = 0;
    let peak = 0;

    const api = stubApi({
      sendMessage: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ROUND_TRIP_MS));
        inFlight -= 1;
        return { messageId: null };
      },
    });

    await sweepBroadcasts(db, api);

    expect(peak).toBeLessThanOrEqual(SEND_CONCURRENCY);
  });

  it('still sends each recipient exactly once', async () => {
    // The guarantee parallelism must not buy speed with. Read from the table
    // rather than from a counter: what the shop is told, and what the customer
    // got, both come from these rows.
    const id = await queueBroadcast(40);
    const seen: number[] = [];
    const api = stubApi({
      sendMessage: async (chatId: number) => {
        seen.push(chatId);
        return { messageId: null };
      },
    });

    await sweepBroadcasts(db, api);

    expect(new Set(seen).size).toBe(seen.length);
    const rows = await db
      .prepare(
        `SELECT status, COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 GROUP BY status`,
      )
      .bind(id)
      .all<{ status: string; n: number }>();
    expect(rows.results).toEqual([{ status: 'SENT', n: 40 }]);
  });

  it('records a refusal against the recipient it belongs to, not the batch', async () => {
    // Concurrency makes it possible to attribute an error to whichever message
    // happened to be in flight. Each worker owns its own row, and this is what
    // says so.
    const id = await queueBroadcast(10);
    let call = 0;
    const api = stubApi({
      sendMessage: async () => {
        // The third send, whichever recipient that turns out to be.
        if (++call === 3) throw new Error('bot was blocked by the user');
        return { messageId: null };
      },
    });

    await sweepBroadcasts(db, api);

    const rows = await db
      .prepare(
        `SELECT status, COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 GROUP BY status ORDER BY status`,
      )
      .bind(id)
      .all<{ status: string; n: number }>();
    expect(rows.results).toEqual([
      { status: 'FAILED', n: 1 },
      { status: 'SENT', n: 9 },
    ]);
  });
});

/**
 * Stopping mid-batch — what a `Promote Production` does to a running broadcast.
 *
 * The sweep claims 200 rows and the pool holds twelve. Until 2026-09-17 an
 * abort left everything claimed-but-not-sent as SENDING for ever: never
 * retried by policy, never closed by `closeFinishedBroadcasts`, and shown to
 * the shop as «مانده» on a number that stopped moving after every deploy.
 * Only a send that was actually in flight is unknowable; the rest was never
 * offered to Telegram and goes back to PENDING for the next process.
 */
describe('a broadcast, stopped', () => {
  it('puts back what it claimed and never sent, and strands nothing', async () => {
    const id = await queueBroadcast(30);
    const controller = new AbortController();
    let sent = 0;
    const api = stubApi({
      sendMessage: async () => {
        sent += 1;
        if (sent === 1) controller.abort();
        await new Promise((r) => setTimeout(r, ROUND_TRIP_MS));
        return { messageId: null };
      },
    });

    await sweepBroadcasts(db, api, controller.signal, 30);

    const rows = await db
      .prepare(
        `SELECT status, COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 GROUP BY status`,
      )
      .bind(id)
      .all<{ status: string; n: number }>();
    const by = Object.fromEntries((rows.results ?? []).map((r) => [r.status, r.n]));
    // The sends already in flight are awaited and recorded, not abandoned.
    expect(by['SENT']).toBe(sent);
    expect(sent).toBeLessThan(30);
    // Everything else is the next container's ordinary work, and it is
    // unclaimed: a stale claimed_at would make it look abandoned.
    expect(by['PENDING']).toBe(30 - sent);
    expect(by['SENDING']).toBeUndefined();
    const stale = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 AND status = 'PENDING' AND claimed_at IS NOT NULL`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });
});

/**
 * The loop around the sweep — the half that decides how many SECONDS a
 * broadcast takes, where the pool decides how many milliseconds a batch does.
 *
 * Until 2026-09-16 the sweep ran once per poll cycle, and on a quiet bot a
 * cycle is the 25-second `getUpdates` wait: 200 messages, then 25 seconds of
 * nothing. Sam: «سرعت ارسال پیام گروهی خیلی پایینه». The drain sends batch
 * after batch while there is anything pending and only sleeps when the queue
 * is empty.
 */
describe('a broadcast, drained', () => {
  it('takes the next batch at once rather than waiting out the idle gap', async () => {
    // Five recipients through batches of two: three claims, and the second
    // and third must follow the first immediately. If the loop slept its
    // idle gap between batches the whole thing would take longer than the
    // gap, which is what the bound below is against — not the laptop's
    // speed: the gap is two full seconds and five sends at pace are 200ms.
    const id = await queueBroadcast(5);
    const controller = new AbortController();
    let sent = 0;
    const api = stubApi({
      sendMessage: async () => {
        sent += 1;
        if (sent === 5) controller.abort();
        return { messageId: null };
      },
    });

    // Not a wall-clock bound. `sleep` is what the loop does between batches
    // when it has nothing, so counting its calls is counting the idle gaps:
    // three batches, zero sleeps — and a loop that slept after every batch
    // would show two, whatever the machine's speed.
    const sleeps = vi.spyOn(globalThis, 'setTimeout');
    await drainBroadcasts(db, api, controller.signal, { limit: 2, idleMs: 2_000 });
    const idled = sleeps.mock.calls.filter(([, ms]) => ms === 2_000).length;
    sleeps.mockRestore();

    expect(sent).toBe(5);
    expect(idled).toBe(0);
    const left = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 AND status <> 'SENT'`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('sleeps only when the queue is empty, and wakes for what arrives', async () => {
    // Nothing queued: the loop must idle, not spin. Then a broadcast lands
    // while it is asleep and is sent on the next wake — the property that lets
    // this loop replace the poll cycle as the thing that notices new work.
    const controller = new AbortController();
    let sent = 0;
    const api = stubApi({
      sendMessage: async () => {
        sent += 1;
        controller.abort();
        return { messageId: null };
      },
    });
    const draining = drainBroadcasts(db, api, controller.signal, { idleMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toBe(0);
    await queueBroadcast(1);
    await draining;
    expect(sent).toBe(1);
  });
});
