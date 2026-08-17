/**
 * The signal the container health check reads.
 *
 * The bot's probe used to be `process.exit(0)` — alive means healthy. Every
 * failure the bot has now happens with the process alive: a poll cycle wedged
 * on a request, Postgres unreachable so every cycle throws and backs off, or a
 * poller waiting for another to release the token. So the question is not "is
 * PID 1 there" but "is the loop still turning", and this is what answers it.
 */

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beat, HEARTBEAT_PATH } from '../src/heartbeat.js';
import { run } from '../src/poll.js';
import type { TelegramApi } from '../src/telegram.js';
import { db } from './helpers/env.js';

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'hb-')), 'alive');

describe('the heartbeat', () => {
  it('writes a fresh timestamp', () => {
    const path = scratch();
    const before = Date.now();
    beat(path);
    const written = Number(readFileSync(path, 'utf8'));
    expect(written).toBeGreaterThanOrEqual(before);
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5_000);
  });

  it('never throws, whatever the filesystem says', () => {
    // A read-only or full disk must not stop the shop selling. It makes the
    // probe stale, which is a false alarm — and a false alarm is a better
    // failure than a bot that stopped because /tmp filled up.
    expect(() => beat(join(scratch(), 'no', 'such', 'dir', 'alive'))).not.toThrow();
  });

  it('defaults somewhere the image can actually write', () => {
    // The container runs as `node`, not root. A default under the repo would
    // have been silently unwritable there and nowhere else.
    expect(HEARTBEAT_PATH.startsWith(tmpdir())).toBe(true);
  });

  it('is beaten once per completed poll cycle, including a failed one', async () => {
    // The important half. A cycle that throws still counts as the loop turning
    // — a database outage is retried every five seconds and the bot is working
    // as designed. What must NOT be reported healthy is a cycle that never
    // returns, and the only way to say that is to beat after it, not before.
    let cycles = 0;
    const api = {
      getUpdates: () => Promise.reject(new Error('telegram is down')),
    } as unknown as TelegramApi;
    const controller = new AbortController();
    const finished = run(db, api, {
      timeoutSec: 1,
      backoffMs: 1,
      signal: controller.signal,
      onCycle: () => {
        cycles += 1;
        if (cycles >= 2) controller.abort();
      },
    });
    await finished;
    expect(cycles).toBeGreaterThanOrEqual(2);
  });
});
