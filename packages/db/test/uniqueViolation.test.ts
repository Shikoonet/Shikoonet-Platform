/**
 * What a uniqueness conflict actually looks like on Postgres.
 *
 * Ten `catch` blocks in the dashboard asked this question with
 * `String(err).includes('UNIQUE')`, which is what SQLite says:
 * `UNIQUE constraint failed: t.c`. Postgres says
 * `duplicate key value violates unique constraint "t_pkey"` — lower case — so
 * every one of those has been false since the move, and each of them has been
 * returning 500 where it meant 409. The ones that also matched an index name by
 * hand kept working, which is exactly why nobody noticed the rest.
 *
 * So this is asked of the driver rather than of a fixture: a real conflict on a
 * real table, and the assertion is against the SQLSTATE the standard defines.
 * A test that built the error object itself would agree with whatever I
 * believed while writing it, which is the belief that was wrong.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isUniqueViolation } from '../src/index.js';

const url = process.env['DATABASE_URL'] ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo';

const client = new pg.Client({ connectionString: url });

/** The error Postgres actually raises, captured once. */
let conflict: unknown;
let otherError: unknown;

beforeAll(async () => {
  await client.connect();
  await client.query('CREATE TEMP TABLE uniq_probe (id int PRIMARY KEY)');
  await client.query('INSERT INTO uniq_probe VALUES (1)');
  try {
    await client.query('INSERT INTO uniq_probe VALUES (1)');
  } catch (e) {
    conflict = e;
  }
  try {
    await client.query('INSERT INTO uniq_probe VALUES (NULL)');
  } catch (e) {
    otherError = e;
  }
});

afterAll(async () => {
  await client.end();
});

describe('isUniqueViolation', () => {
  it('recognises the conflict Postgres raises', () => {
    expect(conflict).toBeDefined();
    expect(isUniqueViolation(conflict)).toBe(true);
  });

  it('is keyed on the SQLSTATE, not on the wording', () => {
    expect((conflict as { code?: string }).code).toBe('23505');
  });

  it('does not fire on a different constraint failure', () => {
    // A NOT NULL violation is 23502. A check that answered true here would turn
    // every write error into "409, try a different value".
    expect(otherError).toBeDefined();
    expect(isUniqueViolation(otherError)).toBe(false);
  });

  it('is false for the things a catch block is handed by mistake', () => {
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key value'))).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('the substring test this replaces does NOT see it — that is the whole bug', () => {
    // Kept as an assertion rather than a comment, because the comment was what
    // let it live: someone reading `includes('UNIQUE')` sees an intention and
    // moves on. This fails the day anybody reintroduces it.
    expect(String(conflict)).not.toContain('UNIQUE');
    expect(String(conflict)).toContain('unique constraint');
  });
});
