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

const url = process.env['DATABASE_URL'] ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo';

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

/**
 * Losing the lock, loudly and quietly — and they need different tests.
 *
 * The first version of this block had one test, killed the backend with
 * `pg_terminate_backend`, and called it proof of the heartbeat. It was green
 * with the heartbeat disabled. `pg_terminate_backend` is a LOUD death: the
 * server sends a FATAL, the driver emits `error`, and the handler that has
 * existed all along fires. Real Postgres cannot produce the failure the
 * heartbeat is for.
 *
 * That failure is a NAT or firewall idling the connection out: no RST, no FIN,
 * no event, and a socket Node still believes in. This connection exists only to
 * hold a lock, so nothing is ever sent on it and nothing ever finds out — the
 * bot polls on without the lock and a second poller can start beside it.
 *
 * So: one test against the real database for the loud path, and one against a
 * client that CANNOT raise an event for the quiet one. The stub is not standing
 * in for Postgres there; it is standing in for a network that says nothing,
 * which is the only thing being tested.
 */
describe('when the lock connection dies underneath us', () => {
  it('notices a backend Postgres killed, and the lock really is gone', async () => {
    const dyingToken = `${token}-heartbeat`;
    let lost: unknown;
    const lock = await acquirePollerLock(
      pool,
      dyingToken,
      () => undefined,
      (err) => {
        lost ??= err;
      },
      // Fast enough that the test does not wait on the real thirty seconds.
      20,
    );
    expect(await heldFor(dyingToken)).toBe(true);

    // Which backend is holding it — asked of `pg_locks`, so the test cannot
    // kill the wrong session and call it a pass.
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1::bigint::int AND objid = $2::bigint::int`,
      [0x5368_0000 | 0, lockKeyForToken(dyingToken)],
    );
    expect(rows).toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);

    // The lock really is gone as far as Postgres is concerned, and the process
    // was told. Both halves are the pre-existing `error` handler's work — this
    // test says that path still works, and says nothing about the heartbeat.
    await expect.poll(() => heldFor(dyingToken), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => lost !== undefined, { timeout: 5_000 }).toBe(true);

    await lock.release();
  });

  it('notices a connection that dies without saying anything', async () => {
    // The quiet death, which no real database will perform on request. `on` is
    // absent, so there is no error event to fire even in principle: if anything
    // reports this loss it is because something ASKED, which is the whole
    // property. `query` answers the lock acquisition and then stops answering,
    // the way a black-holed socket does once its timeout is reached.
    let alive = true;
    let asked = 0;
    let released = 0;
    const client = {
      query: async <R>(sql: string): Promise<{ rows: R[] }> => {
        if (sql === 'SELECT 1') {
          asked += 1;
          if (!alive) throw new Error('connection terminated unexpectedly');
          return { rows: [] as R[] };
        }
        return { rows: [{ got: true } as unknown as R] };
      },
      release: () => {
        released += 1;
      },
      // No `on`, deliberately.
    };

    let lost: unknown;
    const lock = await acquirePollerLock(
      { connect: async () => client },
      `${token}-silent`,
      () => undefined,
      (err) => {
        lost ??= err;
      },
      5,
    );

    // Beating while the connection is fine, and saying nothing about it.
    await expect.poll(() => asked > 0, { timeout: 2_000 }).toBe(true);
    expect(lost).toBeUndefined();

    alive = false;
    await expect.poll(() => lost !== undefined, { timeout: 2_000 }).toBe(true);
    expect(String(lost)).toContain('connection terminated');

    // And once it has reported, it stops: a dead connection asked every five
    // milliseconds for the rest of the process is a log nobody can read.
    const settled = asked;
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toBe(settled);

    await lock.release();
    expect(released).toBe(1);
  });

  it('stops beating once the lock is released', async () => {
    // A timer left running would keep querying a connection that has gone back
    // to the pool, and would report a loss for a lock nobody holds any more.
    const spentToken = `${token}-released`;
    let lost = 0;
    const lock = await acquirePollerLock(
      pool,
      spentToken,
      () => undefined,
      () => {
        lost += 1;
      },
      10,
    );
    await lock.release();
    await new Promise((r) => setTimeout(r, 60));

    expect(lost).toBe(0);
    expect(await heldFor(spentToken)).toBe(false);
  });
});
