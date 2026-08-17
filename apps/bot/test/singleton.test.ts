/**
 * Only one poller per token — against a real Postgres, because the whole point
 * is a real advisory lock.
 *
 * Telegram allows one `getUpdates` caller per token; a second gets 409. On this
 * laptop that happens when a previous run is orphaned, and `docs/STATUS.md`
 * carries it as a troubleshooting row. On the server it is the normal shape of
 * a deploy: Coolify starts the new container before stopping the old one.
 *
 * Unlike the HTTP-level race tests elsewhere in this repo, this one CAN be
 * driven deterministically: two connections either both hold a lock or they do
 * not, and Postgres decides, not the event loop.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { acquirePollerLock, lockKeyForToken } from '../src/singleton.js';

const url =
  process.env['DATABASE_URL'] ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo';

// Through the adapter rather than `pg` directly: this app does not depend on
// the driver, and adding it as a devDependency for one `new Pool` would make
// the test the only reason it is there.
const { pool } = createPostgresD1({ connectionString: url, max: 6 });

afterAll(async () => {
  await pool.end();
});

/** Distinct per test file run, so a leftover lock cannot make this pass. */
const token = `test-token-${process.pid}-${Date.now()}`;

async function heldFor(t: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_locks
      WHERE locktype = 'advisory' AND classid = $1::bigint::int AND objid = $2::bigint::int`,
    [0x5368_0000 | 0, lockKeyForToken(t)],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

describe('the poller lock', () => {
  it('is held after acquiring, and gone after releasing', async () => {
    expect(await heldFor(token)).toBe(false);
    const lock = await acquirePollerLock(pool, token);
    expect(await heldFor(token)).toBe(true);
    await lock.release();
    expect(await heldFor(token)).toBe(false);
  });

  it('makes a second poller wait, and lets it in when the first leaves', async () => {
    const first = await acquirePollerLock(pool, token);

    let waited = false;
    const second = acquirePollerLock(pool, token, () => {
      waited = true;
    });

    // It must not be granted while the first holds it. Racing the promise
    // against a timer is the only way to assert "still waiting" — and the
    // assertion is the timer winning, not a fixed sleep the test then trusts.
    const outcome = await Promise.race([
      second.then(() => 'granted' as const),
      new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 300)),
    ]);
    expect(outcome).toBe('still waiting');
    expect(waited).toBe(true);

    await first.release();
    const lock = await second;
    expect(await heldFor(token)).toBe(true);
    await lock.release();
  });

  it('does not block a different token, because two bots share this database', async () => {
    // The test bot and the production bot run against the same Postgres during
    // the changeover. A lock on a constant would have stopped one of them dead.
    const other = `${token}-other`;
    const a = await acquirePollerLock(pool, token);
    const b = await acquirePollerLock(pool, other);
    expect(await heldFor(token)).toBe(true);
    expect(await heldFor(other)).toBe(true);
    await a.release();
    await b.release();
  });

  it('releases when the connection dies, not when a shutdown path runs', async () => {
    // The case that matters most, and the reason this is a session lock rather
    // than a row somebody has to clean up: `kill -9`, a container stop, a
    // partition. Nothing of ours runs, and the next poller must still start.
    const { pool: solo } = createPostgresD1({ connectionString: url, max: 1 });
    // Killing a backend makes its client emit; unhandled, node turns that into
    // a crash. The bot's own process would be dead at this point, so nobody is
    // listening there either — which is fine, and is why the assertion below is
    // about Postgres's state rather than about this process surviving.
    solo.on('error', () => undefined);
    let lost: unknown;
    await acquirePollerLock(solo, token, undefined, (e) => {
      lost = e;
    });
    expect(await heldFor(token)).toBe(true);

    // Killed from the outside, which is what `docker stop --time 0` and a
    // watchdog both look like to Postgres. Deliberately not `pool.end()`: that
    // waits for the checked-out client this lock is holding, so it hangs — a
    // graceful shutdown is the case this test is NOT about.
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1::bigint::int AND objid = $2::bigint::int`,
      [0x5368_0000 | 0, lockKeyForToken(token)],
    );
    expect(rows[0]?.pid).toBeDefined();
    await pool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);

    for (let i = 0; i < 100 && (await heldFor(token)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await heldFor(token)).toBe(false);
    // The holder is told, rather than left polling a token it no longer owns.
    // In `server.ts` this handler exits the process, so the container restarts
    // and takes the lock again; ignoring it would put a second poller beside a
    // first that still believes it is alone — the exact state this prevents.
    expect(lost).toBeDefined();
    // And a fresh poller gets straight in, which is the property that matters.
    const next = await acquirePollerLock(pool, token);
    await next.release();
    solo.end().catch(() => undefined);
  });

  it('derives its key from the token and nothing else', () => {
    expect(lockKeyForToken('a')).toBe(lockKeyForToken('a'));
    expect(lockKeyForToken('a')).not.toBe(lockKeyForToken('b'));
    // Must fit `pg_advisory_lock(int, int)`.
    expect(Number.isInteger(lockKeyForToken(token))).toBe(true);
    expect(lockKeyForToken(token)).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(lockKeyForToken(token)).toBeLessThan(2 ** 31);
  });
});
