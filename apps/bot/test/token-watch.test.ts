/**
 * `watchBotToken` — the half of "connect a bot from the dashboard" that runs
 * inside the bot.
 *
 * There is one thing worth proving and one thing worth proving harder:
 *
 *   - a changed token fires exactly once (the process is about to exit; firing
 *     twice would mean two exit paths racing)
 *   - a database that throws, or answers with no token at all, fires NOTHING
 *
 * The second is the whole reason this file is separate from the change
 * detection itself. The danger is not a change noticed late — that costs thirty
 * seconds. It is a connection reset being read as "the operator disconnected
 * the bot", which takes a working shop down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@shikoo/database';
import { keyId, seal } from '@shikoo/domain';
import { watchBotToken } from '../src/tokenWatch.js';

const KEY_HEX = 'd'.repeat(64);
const CURRENT = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
/**
 * Deliberately the SAME LENGTH as `CURRENT`.
 *
 * A mutation that replaced the constant-time compare with `next.length ===
 * current.length` survived the first version of this file, because the two
 * fixtures happened to differ in length. A bot swapped for another bot is two
 * tokens of identical shape — so a length check would have shipped, and the
 * watcher would never have noticed the swap it exists to notice.
 */
const CHANGED = '8899001122:AAsecondFakeTokenForTestsOnly_xxxxxxxxxx';

/** A database whose one SELECT is whatever the test says it is this tick. */
function dbAnswering(next: () => Record<string, unknown> | null | Promise<never>): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first() {
          const r = next();
          return r instanceof Promise ? r : Promise.resolve(r);
        },
      };
    },
  } as unknown as D1Database;
}

function row(token: string) {
  // Sealed here rather than written as a fixture string, so the test exercises
  // the real seal/open round trip the watcher depends on.
  //
  // This was a `require()` for one run. In ESM that throws — inside the fake
  // `first()`, where the watcher catches it as a failed read — so every
  // "does not fire" case below passed without the code under test ever
  // resolving a token. Six green tests proving nothing, caught only because
  // the one POSITIVE case went red.
  const key = Buffer.from(KEY_HEX, 'hex');
  return {
    env_name: 'test',
    sealed: seal(token, key),
    key_id: keyId(key),
    bot_id: Number(token.slice(0, token.indexOf(':'))),
    username: 'shikoo_bot',
    first_name: 'Shikoo',
    set_by: 'sam@example.com',
    updated_at: '2026-08-29 12:00:00+00',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  delete process.env['TELEGRAM_BOT_TOKEN'];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

/** One tick of the interval, plus the microtasks its async body queues. */
async function tick(ms = 30_000) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('watchBotToken', () => {
  it('does nothing while the token is the same', async () => {
    const onChange = vi.fn();
    const stop = watchBotToken(dbAnswering(() => row(CURRENT)), 'test', CURRENT, onChange);
    await tick();
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('fires once when the stored token changes', async () => {
    const onChange = vi.fn();
    let token = CURRENT;
    const stop = watchBotToken(
      dbAnswering(() => row(token)),
      'test',
      CURRENT,
      onChange,
    );
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    token = CHANGED;
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    // Still once after another tick: the caller is exiting, and a second call
    // would be a second exit racing the first.
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not fire when the database throws', async () => {
    const onChange = vi.fn();
    const stop = watchBotToken(
      dbAnswering(() => Promise.reject(new Error('connection reset'))),
      'test',
      CURRENT,
      onChange,
    );
    await tick();
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  /**
   * A deleted row on a service with no environment fallback resolves to
   * nothing. Killing a working bot to run no bot is not an improvement, so
   * this is deliberately not a change.
   */
  it('does not fire when there is no token at all', async () => {
    const onChange = vi.fn();
    const stop = watchBotToken(dbAnswering(() => null), 'test', CURRENT, onChange);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('does not fire when the row will not open', async () => {
    const onChange = vi.fn();
    const stop = watchBotToken(
      dbAnswering(() => ({ ...row(CHANGED), sealed: 'not-really-sealed' })),
      'test',
      CURRENT,
      onChange,
    );
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  /**
   * A production row seen by a `test` process. The environment is empty here,
   * so resolution answers nothing — which must not read as "disconnected".
   */
  it('does not fire on a row from another environment', async () => {
    const onChange = vi.fn();
    const stop = watchBotToken(
      dbAnswering(() => ({ ...row(CHANGED), env_name: 'production' })),
      'test',
      CURRENT,
      onChange,
    );
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('stops asking once stopped', async () => {
    const onChange = vi.fn();
    let asked = 0;
    const stop = watchBotToken(
      dbAnswering(() => {
        asked += 1;
        return row(CURRENT);
      }),
      'test',
      CURRENT,
      onChange,
    );
    await tick();
    expect(asked).toBe(1);
    stop();
    await tick();
    await tick();
    expect(asked).toBe(1);
  });
});
