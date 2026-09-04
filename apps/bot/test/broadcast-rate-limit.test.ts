/**
 * A 429 from Telegram, and the customer who used to be lost by it.
 *
 * `sweepBroadcasts` recorded every send error as FAILED and never offered the
 * row again. That was defensible while sending was serial — about four messages
 * a second against Telegram's ceiling of thirty, so a rate limit was not
 * something the shop would meet, and the ordinary failure was a customer who
 * had blocked the bot. Concurrency changed the arithmetic and nobody changed
 * the code: twelve in flight at a 25-per-second pace makes a 429 ordinary, and
 * each one was a customer never told, silently. Issue #90.
 *
 * The line these tests defend is narrower than «retry temporary errors», and
 * the narrowness is the point:
 *
 *   - a 429 is Telegram stating it did NOT deliver this. Safe to send again.
 *   - a 5xx, or a socket that closed, leaves delivery UNKNOWN. Sending again
 *     is the duplicate `PRIMARY KEY (broadcast_id, user_id)` exists to prevent,
 *     and a shop that spams a paying customer has done worse than miss them.
 *
 * So the third test here matters as much as the first: the retry must not
 * spread to anything else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';
import { makeCustomer } from './helpers/shop.js';
import { sweepBroadcasts } from '../src/poll.js';
import { MAX_SEND_ATTEMPTS, SEND_CONCURRENCY } from '../src/broadcast.js';
import { TelegramRejection } from '../src/telegram.js';

let seq = 0;
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** A text broadcast with `count` recipients, all PENDING. */
async function queue(count = 1): Promise<{ id: string; users: number[] }> {
  const id = uuid();
  seq += 1;
  await db
    .prepare(`INSERT INTO broadcasts (id, body, created_by) VALUES (?1, 'سلام', 111)`)
    .bind(id)
    .run();
  const users: number[] = [];
  for (let i = 0; i < count; i++) {
    const telegramId = 780_000_000 + seq * 1000 + i;
    const userId = await makeCustomer(telegramId);
    users.push(userId);
    await db
      .prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id, status)
         VALUES (?1, ?2, ?3, 'PENDING')`,
      )
      .bind(id, userId, telegramId)
      .run();
  }
  return { id, users };
}

async function rowOf(
  id: string,
  userId: number,
): Promise<{ status: string; attempts: number; error: string | null; claimed: boolean }> {
  const r = await db
    .prepare(
      `SELECT status, attempts, error, claimed_at IS NOT NULL AS claimed
         FROM broadcast_recipients WHERE broadcast_id = ?1 AND user_id = ?2`,
    )
    .bind(id, userId)
    .first<{ status: string; attempts: number; error: string | null; claimed: boolean }>();
  return {
    status: r!.status,
    attempts: Number(r!.attempts),
    error: r!.error,
    claimed: r!.claimed,
  };
}

/** Telegram's own shape for «slow down»: a 429 carrying `retry_after`. */
const tooFast = (sec?: number) =>
  new TelegramRejection('telegram sendMessage rejected: Too Many Requests', 429, sec);

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  await db.prepare(`DELETE FROM broadcast_recipients`).run();
  await db.prepare(`DELETE FROM broadcasts`).run();
  vi.restoreAllMocks();
});

describe('a broadcast that Telegram rate-limits', () => {
  it('puts the customer back in the queue instead of losing them', async () => {
    const { id, users } = await queue(1);

    const sent = await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          throw tooFast(1);
        },
      }),
    );

    expect(sent).toBe(0);
    const row = await rowOf(id, users[0]!);
    // PENDING, not FAILED. Before this, that customer was never offered again.
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    // The claim is released with it: a row nobody holds must not look like one
    // somebody abandoned mid-send.
    expect(row.claimed).toBe(false);
    // And nothing is written into `error` yet, because nothing has gone wrong
    // that an operator needs to read.
    expect(row.error).toBeNull();
  });

  it('and the next sweep actually delivers it', async () => {
    const { id, users } = await queue(1);
    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          throw tooFast(1);
        },
      }),
    );

    const sent = await sweepBroadcasts(db, stubApi());

    expect(sent).toBe(1);
    const row = await rowOf(id, users[0]!);
    expect(row.status).toBe('SENT');
    // Exactly once. The whole design is at-most-once, and a retry is where that
    // would be lost.
    expect(row.attempts).toBe(1);
  });

  /**
   * The guard that keeps the retry narrow.
   *
   * A 5xx or a dropped socket means nobody knows whether Telegram accepted the
   * message. Offering it again would risk telling a paying customer the same
   * thing twice, which is worse than missing them once — and it is the exact
   * duplicate the recipient primary key exists to prevent.
   */
  it('does not retry anything except a rate limit', async () => {
    for (const [label, err] of [
      ['a 5xx', new TelegramRejection('telegram sendMessage rejected: Bad Gateway', 502)],
      ['a blocked bot', new TelegramRejection('rejected: Forbidden: bot was blocked', 403)],
      ['a dead socket', new Error('telegram sendMessage failed: socket hang up')],
    ] as const) {
      const { id, users } = await queue(1);
      await sweepBroadcasts(
        db,
        stubApi({
          sendMessage: async () => {
            throw err;
          },
        }),
      );

      const row = await rowOf(id, users[0]!);
      expect(row.status, label).toBe('FAILED');
      expect(row.attempts, label).toBe(0);
      expect(row.error ?? '', label).not.toBe('');
    }
  });

  /**
   * A shop that stays rate-limited for longer than it is patient.
   *
   * Without a ceiling the broadcast neither finishes nor fails, and no screen
   * ever changes. The count is on the row rather than in memory because the
   * process that made the last attempt may not be the one making the next.
   */
  it('gives up after a bounded number of attempts, and says why', async () => {
    const { id, users } = await queue(1);
    const api = stubApi({
      sendMessage: async () => {
        throw tooFast(1);
      },
    });

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) await sweepBroadcasts(db, api);

    const row = await rowOf(id, users[0]!);
    expect(row.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(row.status).toBe('FAILED');
    // The reason reaches the row only at the end, when it is the final word —
    // and it names the attempts as well as the refusal, because «gave up» and
    // «failed once» are different facts to whoever reads this row.
    expect(row.error ?? '').toContain(`after ${MAX_SEND_ATTEMPTS} attempts`);
    expect(row.error ?? '').toContain('Too Many Requests');

    // And it stays given up: a sixth sweep does not pick it back up.
    let tried = 0;
    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          tried += 1;
        },
      }),
    );
    expect(tried).toBe(0);
  });

  /**
   * The pool, not the worker.
   *
   * The limit Telegram applies is on the BOT. Backing off one worker while
   * eleven others carry on earns the next 429 immediately, so the wait has to
   * land on the pace every worker reads.
   */
  it('slows the whole batch down, not just the send that was refused', async () => {
    // MORE recipients than the pool holds, deliberately. With a batch that fits
    // inside the pool every worker has already reserved its slot and called
    // Telegram before the first refusal comes back, so nothing is left to slow
    // down and the test would pass on a broken implementation. The first draft
    // used six and did exactly that.
    const { id } = await queue(SEND_CONCURRENCY + 8);
    const at: number[] = [];
    let first = true;

    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          at.push(Date.now());
          if (first) {
            first = false;
            throw tooFast(1);
          }
        },
      }),
    );

    // Somewhere in there, everybody waited out the second Telegram asked for.
    // Asserted as the largest GAP rather than at a fixed index: which worker
    // sends when is not ordered, and a gap is not a measurement of this
    // machine's speed. The pace is 40ms, so nothing else here comes close.
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(900);

    const done = await db
      .prepare(
        `SELECT count(*)::int AS n FROM broadcast_recipients
          WHERE broadcast_id = ?1 AND status = 'SENT'`,
      )
      .bind(id)
      .first<{ n: number }>();
    expect(Number(done?.n)).toBe(SEND_CONCURRENCY + 7);
  });

  /**
   * A 429 with no `retry_after` is still a 429.
   *
   * «Wait an unspecified amount» and «do not wait» are different instructions,
   * and reading the missing field as zero would turn one rate limit into a
   * stream of them.
   */
  it('waits even when Telegram does not say how long', async () => {
    const { id, users } = await queue(1);
    await sweepBroadcasts(
      db,
      stubApi({
        sendMessage: async () => {
          throw tooFast(undefined);
        },
      }),
    );
    expect((await rowOf(id, users[0]!)).status).toBe('PENDING');
  });
});
