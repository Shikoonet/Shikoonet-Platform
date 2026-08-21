/**
 * Only one process may poll a given bot token.
 *
 * ## Why
 *
 * Telegram allows exactly one `getUpdates` caller per token. A second one gets
 * `409 Conflict` — and `docs/STATUS.md` already carries that symptom as a
 * troubleshooting row, because it happens on this laptop whenever a previous
 * run is orphaned. On the server it is not an accident but the normal shape of
 * a deploy: Coolify starts the new container before it stops the old one, so
 * every deploy has a window with two pollers on one token.
 *
 * The 409s are the visible half. The invisible half is worse: `getUpdates`
 * hands each update to whichever caller asked, so during that window some
 * customers' presses go to a container that is about to be killed. Nothing is
 * lost — `telegram_updates` claims each update exactly once and Telegram
 * redelivers what was never acknowledged — but the races this project spent the
 * week closing (`0022`, `0023`) all become reachable at once, because "the bot
 * is a single writer" stops being true.
 *
 * ## How
 *
 * A session-level `pg_advisory_lock`, held on **its own connection** for the
 * lifetime of the process. Session-level rather than transaction-level because
 * there is no transaction here to hold it; its own connection because a pooled
 * one would be handed to somebody else's query and the lock would travel with
 * it. Postgres releases it when the connection dies, which covers `kill -9`,
 * a container stop, and a network partition alike — nothing has to be cleaned
 * up by a shutdown path that might not run.
 *
 * Keyed on the **token**, not on a constant: the test bot and the production
 * bot share this database during the changeover, and they must not block each
 * other. The token itself never leaves this file — only a hash of it reaches
 * the query, and only as two integers.
 *
 * Blocking rather than fail-fast, deliberately. A rolling deploy resolves
 * itself in seconds once the old container exits, and a new process that gave
 * up would leave the shop with no bot while the deploy reported success. It
 * says so in the log first, because a process waiting silently on a lock is
 * indistinguishable from a hung one.
 *
 * ## The heartbeat, and what "the connection died" actually looks like
 *
 * Postgres releases the lock the moment the connection goes, and the `error`
 * event below is how this process finds out. That is enough for the loud
 * failures — a killed backend, a restarted database, a reset socket — because
 * the driver hears something.
 *
 * It is not enough for the quiet one. A NAT or firewall that idles a connection
 * out drops packets in silence: no RST, no FIN, no error event. The socket
 * stays open as far as Node is concerned, nothing is ever sent on it because
 * this connection exists only to hold a lock, and the process polls Telegram
 * happily for hours while Postgres has long since handed the lock to somebody
 * else. Two pollers, and the guard that exists to prevent exactly that is the
 * thing that cannot see it.
 *
 * So the connection is not idle any more. A `SELECT 1` every thirty seconds
 * keeps the middlebox from calling it dead, and — the half that matters — is
 * the thing that FAILS when it already has. Its rejection goes to the same
 * `onLost`, which stops the process.
 *
 * `pg_advisory_lock` is session-scoped and re-entrant, and `pool.connect()`
 * does not reconnect underneath us, so a `SELECT 1` that answers is proof the
 * session is the same one that took the lock. There is nothing further to ask.
 */

import { createHash } from 'node:crypto';

/**
 * The two methods this needs from a `pg.Pool`, named structurally so this app
 * does not have to declare `pg` as a dependency of its own for one import.
 */
interface LockClient {
  query<R>(sql: string, values: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
  /** Present on a real client; absent in a hand-written stub. */
  on?(event: 'error', listener: (err: unknown) => void): void;
}
export interface LockPool {
  connect(): Promise<LockClient>;
}

/**
 * A namespace for this lock, so the two-int form cannot collide with anything
 * else that takes an advisory lock on this database. `packages/db` uses the
 * single-bigint form for the schema ledger, which is a different lock space.
 */
const BOT_LOCK_NAMESPACE = 0x5368_0000 | 0; // 'Sh'

/**
 * How often the lock connection proves it is still there.
 *
 * Well inside the shortest idle timeout worth worrying about — cloud NATs
 * commonly reap at sixty seconds — and cheap enough to be uninteresting: one
 * `SELECT 1` every thirty seconds on a connection that is otherwise doing
 * nothing at all.
 */
export const LOCK_HEARTBEAT_MS = 30_000;

/** Derives the second key from the token, without the token reaching the log. */
export function lockKeyForToken(token: string): number {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  // A signed 32-bit int, which is what `pg_advisory_lock(int, int)` takes.
  return digest.readInt32BE(0);
}

export interface PollerLock {
  /** Closes the connection, which is what releases the lock. */
  release(): Promise<void>;
}

/**
 * Takes the poller lock, waiting for it if another process holds it.
 *
 * `onWait` is called once, before blocking, so the operator reading a deploy
 * log can tell "waiting for the old container" from "wedged".
 */
export async function acquirePollerLock(
  pool: LockPool,
  token: string,
  onWait: () => void = () => undefined,
  onLost: (err: unknown) => void = () => undefined,
  heartbeatMs: number = LOCK_HEARTBEAT_MS,
): Promise<PollerLock> {
  const key = lockKeyForToken(token);
  const client = await pool.connect();
  // Losing this connection means losing the lock — Postgres drops it the moment
  // the socket goes. Two things follow, and both need saying out loud:
  //
  //   - unhandled, the error event alone would take the process down, which is
  //     the right outcome for the wrong reason;
  //   - handled and ignored, the bot would keep polling while no longer holding
  //     the lock, so a second poller could start beside it. That is exactly the
  //     state this file exists to prevent, and it would be silent.
  //
  // So it is handed to the caller, which stops. A restart re-acquires.
  client.on?.('error', onLost);
  try {
    const { rows } = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS got',
      [BOT_LOCK_NAMESPACE, key],
    );
    if (rows[0]?.got !== true) {
      onWait();
      // Blocks until the holder's connection goes away. No timeout: the only
      // thing that could hold it is another poller for this same token, and
      // waiting for it is exactly right.
      await client.query('SELECT pg_advisory_lock($1, $2)', [BOT_LOCK_NAMESPACE, key]);
    }
  } catch (err) {
    client.release();
    throw err;
  }
  // Only once the lock is actually held: a heartbeat started before it would
  // fire while `pg_advisory_lock` is still blocking on the same connection, and
  // the two would queue behind each other.
  let lost = false;
  const heartbeat = setInterval(() => {
    void client.query('SELECT 1', []).catch((err: unknown) => {
      if (lost) return;
      lost = true;
      clearInterval(heartbeat);
      onLost(err);
    });
  }, heartbeatMs);
  // Does not hold the process open on its own. What keeps this process alive is
  // the poll loop; a timer that outlived it would turn a clean exit into a hang.
  heartbeat.unref?.();

  return {
    async release() {
      clearInterval(heartbeat);
      // Unlock first so a pooled connection does not carry the lock back into
      // the pool, then hand it back.
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [BOT_LOCK_NAMESPACE, key])
        .catch(() => undefined);
      client.release();
    },
  };
}
