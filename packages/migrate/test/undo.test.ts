/**
 * `undo.ts` — taking back exactly the rows one transaction wrote.
 *
 * Against a real Postgres, because every claim this module makes is a claim
 * about Postgres: `xmin`, primary keys read out of `pg_constraint`, foreign
 * keys that refuse a delete, and the append-only trigger on `wallet_entries`.
 * A stub would be asserting that this file agrees with itself.
 *
 * The tables used are the real ones. A fixture schema would have proved the
 * algorithm against a shape nothing in production has — no self-referencing
 * key on `users`, no `deny_mutation`, no cycle between `orders` and
 * `subscriptions` — which is to say it would have proved nothing worth knowing.
 *
 * Everything here is scoped to one telegram id far outside both the seed range
 * and the real one, and removed afterwards whether the test passed or not.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { connectPostgres, loadConfig, report } from '../src/db.js';
import { applyUndo, beginUndo, captureUndo, dropUndo, undoSchemaFor } from '../src/undo.js';

/** Outside the `9000000xx` seed block and outside any real Mirzabot id. */
const KEEPER = 990_900_001;
const IMPORTED = 990_900_002;

const SCHEMA = undoSchemaFor('11111111-2222-3333-4444-555555555555');

let pgc: pg.Client;

/**
 * The same number `@shikoo/seed` refuses to wipe past, for the same reason:
 * a connection string can be forged by a tunnel, eleven thousand customers
 * cannot. Asked of the database, not of DATABASE_URL.
 */
const NOT_A_SIMULATION = 1_000;

/**
 * Why this file, and not the rest of the suite.
 *
 * Every other database test scopes its deletes to a telegram id range it
 * owns. `applyUndo` does not: it deletes whatever the recording holds, from
 * every table the recording names. That is exactly right in production and
 * exactly wrong to point at a database somebody is working in.
 *
 * On 2026-09-02 I proved the `xmin` guard the way this repo asks — by
 * removing it — with DATABASE_URL still on the simulation database. With
 * `WHERE true` in its place the recording held every row in the database, and
 * the next test deleted them: 8,303 orders, every discount code, every card
 * lease, every audit row. The guard was proved. So was the absence of this
 * one.
 */
beforeAll(async () => {
  const c = await connectPostgres(loadConfig());
  try {
    const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM users');
    const users = Number(rows[0]?.n ?? 0);
    if (users >= NOT_A_SIMULATION) {
      throw new Error(
        `refusing to run undo tests: this database holds ${users} users, which is ` +
          'not a scratch database. These tests delete whatever the recording holds. ' +
          'Point DATABASE_URL at a disposable Postgres.',
      );
    }
  } finally {
    await c.end().catch(() => undefined);
  }
});

/** `report` writes to stdout; these tests are about rows, not narration. */
const quiet = () => {
  const real = console.log;
  console.log = () => undefined;
  return () => {
    console.log = real;
  };
};

async function userIdFor(telegramId: number): Promise<number | null> {
  const { rows } = await pgc.query<{ id: string }>('SELECT id FROM users WHERE telegram_id = $1', [
    telegramId,
  ]);
  return rows[0] ? Number(rows[0].id) : null;
}

beforeEach(async () => {
  pgc = await connectPostgres(loadConfig());
  await dropUndo(pgc, SCHEMA);
  await pgc.query('DELETE FROM wallet_entries WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ANY($1))', [[KEEPER, IMPORTED]]).catch(() => undefined);
  await pgc.query('DELETE FROM users WHERE telegram_id = ANY($1)', [[KEEPER, IMPORTED]]);

  // The row that was already there. Committed on its own, so it carries a
  // different `xmin` from the one the "import" below will run under — which is
  // the entire mechanism under test.
  await pgc.query(
    `INSERT INTO users (telegram_id, status, registered_at) VALUES ($1, 'ACTIVE', now())`,
    [KEEPER],
  );
});

afterEach(async () => {
  await dropUndo(pgc, SCHEMA).catch(() => undefined);
  await pgc
    .query('DELETE FROM wallet_entries WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ANY($1))', [[KEEPER, IMPORTED]])
    .catch(() => undefined);
  await pgc.query('DELETE FROM users WHERE telegram_id = ANY($1)', [[KEEPER, IMPORTED]]).catch(() => undefined);
  await pgc.end().catch(() => undefined);
});

/** One "import": a transaction that writes, records itself, and commits. */
async function importOneUser(): Promise<void> {
  const restore = quiet();
  try {
    await pgc.query('BEGIN');
    await beginUndo(pgc, SCHEMA);
    await pgc.query(
      `INSERT INTO users (telegram_id, status, registered_at) VALUES ($1, 'ACTIVE', now())`,
      [IMPORTED],
    );
    await captureUndo(pgc, SCHEMA);
    await pgc.query('COMMIT');
  } finally {
    restore();
  }
}

describe('what a run is judged to have written', () => {
  it('records the rows this transaction inserted and not the ones already there', async () => {
    await importOneUser();

    const { rows } = await pgc.query<{ id: string }>(`SELECT id FROM ${SCHEMA}.users`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.id)).toBe(await userIdFor(IMPORTED));
  });

  it('names only the tables that moved', async () => {
    await importOneUser();

    const { rows } = await pgc.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA],
    );
    // 71 tables exist; one was written to. A recording that listed them all
    // would still "work" and would tell a reader nothing.
    expect(rows.map((r) => r.table_name)).toEqual(['users']);
  });
});

describe('taking it back', () => {
  it('removes what the run wrote and leaves what was already there', async () => {
    await importOneUser();
    expect(await userIdFor(IMPORTED)).not.toBeNull();

    const restore = quiet();
    try {
      await pgc.query('BEGIN');
      const result = await applyUndo(pgc, SCHEMA);
      await pgc.query('COMMIT');
      expect(result.total).toBe(1);
      expect(result.removed).toEqual([{ table: 'users', rows: 1 }]);
    } finally {
      restore();
    }

    expect(await userIdFor(IMPORTED)).toBeNull();
    // The whole reason Sam chose this over a restore.
    expect(await userIdFor(KEEPER)).not.toBeNull();
  });

  it('leaves a row created AFTER the import alone', async () => {
    await importOneUser();

    // A purchase, a signup — anything that happened between the import and the
    // regret. A snapshot diff would have called this "something the import
    // added"; `xmin` does not.
    await pgc.query(
      `INSERT INTO users (telegram_id, status, registered_at) VALUES ($1, 'ACTIVE', now())`,
      [KEEPER + 100],
    );
    try {
      const restore = quiet();
      try {
        await pgc.query('BEGIN');
        await applyUndo(pgc, SCHEMA);
        await pgc.query('COMMIT');
      } finally {
        restore();
      }
      expect(await userIdFor(KEEPER + 100)).not.toBeNull();
    } finally {
      await pgc.query('DELETE FROM users WHERE telegram_id = $1', [KEEPER + 100]);
    }
  });

  it('puts the append-only trigger back', async () => {
    await importOneUser();

    const restore = quiet();
    try {
      await pgc.query('BEGIN');
      await applyUndo(pgc, SCHEMA);
      await pgc.query('COMMIT');
    } finally {
      restore();
    }

    // Asserted from `pg_trigger`, not from the fact that nothing threw. A
    // trigger left disabled is a rule silently repealed for every later writer.
    const { rows } = await pgc.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_wallet_entries_append_only'`,
    );
    expect(rows[0]?.tgenabled).not.toBe('D');
  });

  it('is a no-op on a recording that holds nothing', async () => {
    await pgc.query('BEGIN');
    const restore = quiet();
    try {
      await beginUndo(pgc, SCHEMA);
      await captureUndo(pgc, SCHEMA);
    } finally {
      restore();
      await pgc.query('COMMIT');
    }
    const out = await applyUndo(pgc, SCHEMA);
    expect(out).toEqual({ removed: [], total: 0 });
  });
});

describe('a row the run only touched', () => {
  /**
   * The bug CodeRabbit found on PR #57, kept as a test because reasoning about
   * it is what got it wrong the first time.
   *
   * `xmin` is the transaction that created the tuple *version*, and an UPDATE
   * creates a new version — so a row that existed for a year and that the
   * migration merely edited answers `xmin = pg_current_xact_id()` exactly like
   * one it inserted. The migration does this in three places, one of them
   * `users.referred_by`, which is what this reproduces.
   *
   * Deleting such a row would be worse than not undoing it: the customer was
   * never imported, they were only pointed at a referrer.
   */
  it('is left alone, because the run edited it rather than writing it', async () => {
    const referrer = await pgc.query<{ id: string }>(
      'SELECT id FROM users WHERE telegram_id = $1',
      [KEEPER],
    );

    const restore = quiet();
    try {
      await pgc.query('BEGIN');
      await beginUndo(pgc, SCHEMA);
      // What `migrateReferrals` does, on a customer who was already here.
      await pgc.query('UPDATE users SET referral_bonus_claimed = true WHERE id = $1', [
        referrer.rows[0]!.id,
      ]);
      await captureUndo(pgc, SCHEMA);
      await pgc.query('COMMIT');
    } finally {
      restore();
    }

    // Recorded nothing at all: the only row that moved was one that was
    // already there.
    const { rows } = await pgc.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA],
    );
    expect(rows).toHaveLength(0);

    const out = await applyUndo(pgc, SCHEMA);
    expect(out.total).toBe(0);
    expect(await userIdFor(KEEPER)).not.toBeNull();
  });

  it('keeps the snapshots out of the kept recording', async () => {
    // `beginUndo` copies every primary key in the database. If those tables
    // survived the capture, a recording kept for weeks would be the size of
    // the database rather than the size of what it can take back — and
    // `applyUndo` reads the schema's table list to decide what to delete, so
    // a leftover snapshot would also be read as rows to remove.
    await importOneUser();
    const { rows } = await pgc.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name)).toEqual(['users']);
  });
});

describe('the schema name', () => {
  it('comes from the run id, so a row and a schema cannot disagree', () => {
    expect(undoSchemaFor('a1b2c3d4-0000-1111-2222-333344445555')).toBe(
      'import_undo_a1b2c3d4_0000_1111_2222_333344445555',
    );
  });

  it('is a legal unquoted identifier and short enough for Postgres', () => {
    const name = undoSchemaFor('a1b2c3d4-0000-1111-2222-333344445555');
    expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

// `report` is imported so the module's narration is exercised rather than
// tree-shaken out of the type check; nothing here asserts on it.
void report;
