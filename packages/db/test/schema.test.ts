/**
 * The schema ledger, against a real Postgres.
 *
 * Every case here is one that actually happened or is one deploy away:
 * production carrying the schema and no ledger, a migration on disk that nobody
 * ran, an applied file edited afterwards, two replicas deploying at once. A
 * fake client would let all of them pass — advisory locks and transactional DDL
 * are exactly the behaviour under test.
 *
 * Each test gets its own scratch schema so nothing touches the simulation's
 * real tables, and so `looksAlreadyMigrated` can be given a database that
 * genuinely has `users` and one that genuinely does not.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  baseline,
  gateReasons,
  looksAlreadyMigrated,
  readMigrations,
  status,
  up,
} from '../src/schema.js';

const url = process.env['DATABASE_URL'] ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo';

const client = new pg.Client({ connectionString: url });
await client.connect();

/** A scratch schema, so `users` here is ours and not the simulation's. */
let space: string;
let n = 0;

beforeEach(async () => {
  space = `ledger_test_${Date.now()}_${n++}`;
  await client.query(`CREATE SCHEMA ${space}`);
  await client.query(`SET search_path TO ${space}`);
});

afterAll(async () => {
  await client.query('SET search_path TO public');
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ledger_test_%'`,
  );
  for (const r of rows) await client.query(`DROP SCHEMA ${r.nspname} CASCADE`);
  await client.end();
});

/** A directory of migrations, written for the test rather than borrowed. */
function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
  return d;
}

const TWO = {
  '0001_a.sql': 'CREATE TABLE a (id int);',
  '0002_b.sql': 'CREATE TABLE b (id int);',
};

describe('the schema ledger', () => {
  it('reports every file as pending on an empty database', async () => {
    const s = await status(client, dirWith(TWO));
    expect(s.pending).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(s.applied).toEqual([]);
  });

  it('applies them in order and records what it ran', async () => {
    const dir = dirWith(TWO);
    const r = await up(client, dir, 'test');
    expect(r.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    const after = await status(client, dir);
    expect(after.pending).toEqual([]);
    expect(after.applied).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('is a no-op the second time', async () => {
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    const again = await up(client, dir, 'test');
    expect(again.alreadyCurrent).toBe(true);
    expect(again.applied).toEqual([]);
  });

  it('applies only what is new when a migration is added', async () => {
    // The everyday case, and the one that was silently skipped in production on
    // 2026-08-17: the code shipped with `0021` and the database had `0020`.
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    writeFileSync(join(dir, '0003_c.sql'), 'CREATE TABLE c (id int);');
    const s = await status(client, dir);
    expect(s.pending).toEqual(['0003_c.sql']);
    const r = await up(client, dir, 'test');
    expect(r.applied).toEqual(['0003_c.sql']);
  });

  it('refuses when an applied migration was edited afterwards', async () => {
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra text);');
    const s = await status(client, dir);
    expect(s.drifted.map((d) => d.name)).toEqual(['0001_a.sql']);
    await expect(up(client, dir, 'test')).rejects.toThrow(/changed on disk/);
  });

  it('notices a database that is ahead of the checkout', async () => {
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    // The same ledger read against a checkout that never had `0002` — a
    // rollback of the code without a rollback of the schema.
    const older = dirWith({ '0001_a.sql': TWO['0001_a.sql'] });
    const s = await status(client, older);
    expect(s.unknown).toEqual(['0002_b.sql']);
  });

  it('refuses to let a container start on a migration nobody ran', async () => {
    // 2026-08-17, exactly: the code wanted a column the database did not have,
    // the container started anyway, and every login answered 500.
    const dir = dirWith(TWO);
    const { blocking } = gateReasons(await status(client, dir));
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('0001_a.sql');
    expect(blocking[0]).toContain('0002_b.sql');
  });

  it('refuses to start on a migration that was edited after it was applied', async () => {
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    const edited = dirWith({ ...TWO, '0001_a.sql': 'CREATE TABLE a (id bigint);' });
    const { blocking } = gateReasons(await status(client, edited));
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('0001_a.sql');
  });

  it('lets a rollback start, and says the database is ahead', async () => {
    // The case that separates `gate` from `status`. Yesterday's image against
    // today's schema is what a rollback IS, and it is made under pressure with
    // something already broken — a gate that blocks it is a gate that fires
    // exactly when it must not. Migrations here are additive, so the older code
    // runs; it is told, and allowed through.
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    const older = dirWith({ '0001_a.sql': TWO['0001_a.sql'] });

    const s = await status(client, older);
    const { blocking, warnings } = gateReasons(s);

    // `status` still calls this a mismatch — that question has not changed.
    expect(s.unknown).toEqual(['0002_b.sql']);
    expect(blocking).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('0002_b.sql');
  });

  it('says nothing at all when the database matches', async () => {
    const dir = dirWith(TWO);
    await up(client, dir, 'test');
    expect(gateReasons(await status(client, dir))).toEqual({ blocking: [], warnings: [] });
  });

  it('rolls a failing migration back and does not record it', async () => {
    const dir = dirWith({
      '0001_a.sql': 'CREATE TABLE a (id int);',
      '0002_bad.sql': 'CREATE TABLE b (id int); SELECT nonexistent_function();',
    });
    await expect(up(client, dir, 'test')).rejects.toThrow(/0002_bad\.sql failed/);
    const s = await status(client, dir);
    // The first one stands, the second is still pending, and nothing of it
    // survives — re-running retries exactly it.
    expect(s.applied).toEqual(['0001_a.sql']);
    expect(s.pending).toEqual(['0002_bad.sql']);
    const { rows } = await client.query(`SELECT to_regclass('${space}.b') IS NULL AS gone`);
    expect(rows[0].gone).toBe(true);
  });

  it('refuses to run 0001 on a database that already has the schema', async () => {
    // Production on 2026-08-17: 62 tables, 11,241 customers, no ledger. Without
    // this the first `up` would try to CREATE TABLE users and fail somewhere
    // less honest.
    await client.query('CREATE TABLE users (id int)');
    const dir = dirWith(TWO);
    expect(await looksAlreadyMigrated(client)).toBe(true);
    await expect(up(client, dir, 'test')).rejects.toThrow(/no ledger/);
  });

  it('baselines an existing database, then applies only what came after', async () => {
    await client.query('CREATE TABLE users (id int)');
    const dir = dirWith({
      ...TWO,
      '0003_c.sql': 'CREATE TABLE c (id int);',
    });
    const marked = await baseline(client, dir, '0002_b.sql', 'test');
    expect(marked).toEqual(['0001_a.sql', '0002_b.sql']);
    const r = await up(client, dir, 'test');
    // `0001` and `0002` are recorded without being run — `a` and `b` are not
    // created, which is the whole point of a baseline.
    expect(r.applied).toEqual(['0003_c.sql']);
    const { rows } = await client.query(`SELECT to_regclass('${space}.a') IS NULL AS gone`);
    expect(rows[0].gone).toBe(true);
  });

  it('names an unknown baseline target instead of silently marking nothing', async () => {
    await expect(baseline(client, dirWith(TWO), '0099_nope.sql', 'test')).rejects.toThrow(
      /no migration named 0099_nope\.sql/,
    );
  });

  it('reads 0*.sql and nothing else', async () => {
    // `verify_invariants.sql` lives beside the migrations and is not one. The
    // glob is `0*.sql` rather than `000*.sql`, which would silently drop
    // everything from 0010 on — a mistake already made by hand.
    const dir = dirWith({
      '0001_a.sql': 'SELECT 1;',
      '0010_j.sql': 'SELECT 1;',
      'verify_invariants.sql': 'SELECT 1;',
      'README.md': 'not sql',
    });
    expect(readMigrations(dir).map((f) => f.name)).toEqual(['0001_a.sql', '0010_j.sql']);
  });

  it('lets only one runner apply at a time', async () => {
    // Two replicas deploying at once. The second must wait for the first rather
    // than both running `0002`, which is what the advisory lock is for.
    const dir = dirWith(TWO);
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${space}`);
      const [a, b] = await Promise.all([up(client, dir, 'one'), up(other, dir, 'two')]);
      // Between them every migration ran exactly once: one runner did the work
      // and the other found nothing to do.
      expect([...a.applied, ...b.applied].sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    } finally {
      await other.end();
    }
  });
});
