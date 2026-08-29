/**
 * `loadDump` — standing a dump up in a scratch MySQL.
 *
 * This is the one piece of the panel import that has no CLI ancestor, so it is
 * also the one with no prior evidence behind it. It runs against the synthetic
 * fixture rather than the production dump, for the reason
 * `synthetic-migration.test.ts` sets out: this asks «does the loader work»,
 * which is a question about the code and belongs in CI, not «is this data safe
 * to move», which is a question about the dump and belongs on Sam's machine.
 *
 * Gated on the same `MIGRATE_FIXTURE_MYSQL=1` as that file, and for the same
 * reason — most laptops have no MySQL running, and a failure there is not the
 * developer's fault.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { configFrom } from '../src/db.js';
import { loadDump } from '../src/load.js';

const ENABLED = process.env['MIGRATE_FIXTURE_MYSQL'] === '1';
const describeIf = ENABLED ? describe : describe.skip;

const FIXTURE = new URL('./fixtures/synthetic-mirzabot.sql', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

/** A scratch name of its own, so this never touches the database CI loaded. */
const SCRATCH = 'mirzabot_load_test';

function cfg() {
  return configFrom({
    mysql: {
      host: process.env['MYSQL_HOST'] ?? '127.0.0.1',
      port: Number(process.env['MYSQL_PORT'] ?? 3307),
      user: process.env['MYSQL_USER'] ?? 'root',
      password: process.env['MYSQL_PASSWORD'] ?? 'shikoo_local',
      database: SCRATCH,
    },
    // Never opened by `loadDump`; present because Config demands it.
    postgres: { connectionString: 'postgres://unused/unused' },
  });
}

let tmp: string;
let conn: Connection;

beforeAll(async () => {
  if (!ENABLED) return;
  tmp = mkdtempSync(join(tmpdir(), 'shikoo-load-'));
  conn = await createConnection({
    host: cfg().mysql.host,
    port: cfg().mysql.port,
    user: cfg().mysql.user,
    password: cfg().mysql.password,
  });
});

afterAll(async () => {
  if (!ENABLED) return;
  await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``).catch(() => undefined);
  await conn.end().catch(() => undefined);
});

describeIf('loadDump', () => {
  it('loads a plain .sql and reports what landed', async () => {
    const result = await loadDump(cfg(), FIXTURE);
    expect(result.database).toBe(SCRATCH);
    expect(result.tables).toBeGreaterThan(0);
    expect(result.sha256).toHaveLength(64);

    const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${SCRATCH}\`.\`user\``);
    expect(Number((rows as { n: number }[])[0]!.n)).toBeGreaterThan(0);
  });

  it('reads a .sql.gz as the same dump', async () => {
    const gz = join(tmp, 'fixture.sql.gz');
    writeFileSync(gz, gzipSync(readFileSync(FIXTURE)));

    const plain = await loadDump(cfg(), FIXTURE);
    const zipped = await loadDump(cfg(), gz);
    // The checksum is of the decompressed SQL, so compression is not part of
    // the dump's identity: the same bytes gzipped are the same import.
    expect(zipped.sha256).toBe(plain.sha256);
    expect(zipped.sha256).toBe(createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'));
    expect(zipped.tables).toBe(plain.tables);
  });

  it('drops what a previous dump left, rather than merging two sources', async () => {
    await loadDump(cfg(), FIXTURE);
    await conn.query(`CREATE TABLE \`${SCRATCH}\`.leftover (a int)`);
    await loadDump(cfg(), FIXTURE);

    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 'leftover'`,
      [SCRATCH],
    );
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
  });

  it('refuses a .gz that is not gzip, rather than loading garbage', async () => {
    const fake = join(tmp, 'lying.sql.gz');
    writeFileSync(fake, 'SELECT 1;');
    await expect(loadDump(cfg(), fake)).rejects.toThrow(/not gzip/);
  });

  it('refuses a database name it would have to interpolate unquoted', async () => {
    const bad = configFrom({
      mysql: { ...cfg().mysql, database: 'shikoo`; DROP DATABASE shikoo; --' },
      postgres: { connectionString: 'postgres://unused/unused' },
    });
    await expect(loadDump(bad, FIXTURE)).rejects.toThrow(/refusing to use/);
  });
});
