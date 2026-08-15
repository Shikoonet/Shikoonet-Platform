/**
 * The guards on the most destructive command in this repository.
 *
 * `seed:sim` truncates every table it is pointed at. Until now the only thing
 * standing between it and somebody's customers was the hostname in a connection
 * string — and `127.0.0.1` is precisely what the far end of an SSH tunnel looks
 * like, which is how a cutover night is largely conducted.
 *
 * `docs/STATUS.md` already records one occasion where a suite wiped `users` in
 * the middle of a manual test. That was the simulation. The same mistake with a
 * tunnel open is not recoverable.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { assertLocal, assertNotRealData } from '../src/run.js';

const savedEnvName = process.env.ENV_NAME;
afterEach(() => {
  if (savedEnvName === undefined) delete process.env.ENV_NAME;
  else process.env.ENV_NAME = savedEnvName;
});

/** A database that answers one question, so the threshold can be tested at it. */
function withUsers(n: number) {
  return {
    prepare: () => ({ first: async () => ({ n }) }),
  } as unknown as ReturnType<typeof createPostgresD1>['db'];
}

describe('where it may be pointed', () => {
  it('refuses a database on another machine', () => {
    expect(() => assertLocal('postgres://u:p@db.example.com:5432/shikoo')).toThrow(/non-local/);
  });

  it('refuses even a local one while ENV_NAME says production', () => {
    // The tunnel case. The address is local and means nothing; the operator has
    // already said what this is.
    process.env.ENV_NAME = 'production';
    expect(() => assertLocal('postgres://u:p@127.0.0.1:5433/shikoo')).toThrow(/production/);
  });

  it('allows the simulation', () => {
    delete process.env.ENV_NAME;
    expect(() => assertLocal('postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo')).not.toThrow();
  });
});

describe('what it finds when it looks', () => {
  it('refuses a database holding a real customer list', async () => {
    // Production holds 11,241. The message carries the count, so whoever sees
    // it at 3am knows immediately which database they just aimed at.
    await expect(assertNotRealData(withUsers(11_241))).rejects.toThrow(/11241 users/);
  });

  it('allows the simulation, which the seed leaves with none', async () => {
    await expect(assertNotRealData(withUsers(0))).resolves.toBeUndefined();
  });

  it('allows what a test run leaves behind', async () => {
    // The bot suite creates users as it goes and `seed:sim` is documented as
    // the thing you run afterwards. A guard that broke that loop would be
    // turned off within a week.
    await expect(assertNotRealData(withUsers(60))).resolves.toBeUndefined();
  });

  it('asks the real database the question it claims to ask', async () => {
    // The three above test the decision against a stub. This one runs the
    // actual statement against the simulation, so a typo in the SQL — or a
    // `users` table that stops existing — cannot pass unnoticed.
    const { db, pool } = createPostgresD1({ connectionString: process.env.DATABASE_URL! });
    try {
      await expect(assertNotRealData(db)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
