/**
 * Something the bot's health check can actually ask.
 *
 * ## Why there was nothing
 *
 * The Dockerfile's probe reads `SERVICE` and, for anything that is not ingest
 * or dashboard, runs `process.exit(0)`. Its own comment is honest about it:
 * "proves only that PID 1 is alive, which Docker already knew". The reasoning
 * was that the bot opens no port, so there is nothing to ask — and that its
 * real failure mode is exiting, which is visible without a probe.
 *
 * That is true of the failure the bot had at the time. It is not true of the
 * ones it has now. A process that is alive and not polling is the shape of
 * every interesting failure here: the poll loop wedged on a request with no
 * timeout, Postgres unreachable so every cycle throws and backs off for ever,
 * or — since `singleton.ts` — a process that started, found another poller
 * holding the token, and is waiting. In all three the container is up, the logs
 * may be quiet, and no customer message is being answered.
 *
 * ## What this is
 *
 * A file whose modification time is bumped once per completed poll cycle. The
 * probe checks its age. No port, no second HTTP server, no database connection
 * from a probe that runs every thirty seconds.
 *
 * A file rather than a row on purpose. The health of *this container* is the
 * question, and a row keyed by anything else answers about the fleet; a row
 * keyed by this container answers only after the probe can already reach the
 * database, which is one of the things being tested. The filesystem is the only
 * thing left that both sides can see and neither can fake.
 *
 * Failures to write are swallowed. A read-only or full filesystem must not stop
 * the bot from serving customers — it makes the probe stale, which is a
 * false alarm, and a false alarm is a better failure than a shop that stopped.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Under the OS temp dir so the image's non-root user can always write it, and
 * so nothing survives a container restart — a stale file from a previous life
 * answering for a process that never started would be worse than no file.
 */
export const HEARTBEAT_PATH = process.env['BOT_HEARTBEAT_PATH'] ?? join(tmpdir(), 'shikoo-bot-alive');

export function beat(path: string = HEARTBEAT_PATH): void {
  try {
    writeFileSync(path, String(Date.now()), 'utf8');
  } catch {
    // Deliberately silent. See the note above: a probe that goes stale is a
    // false alarm; a bot that stops selling because /tmp is full is an outage.
  }
}
