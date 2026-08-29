/**
 * Loads a Mirzabot `mysqldump` file into a scratch MySQL database.
 *
 * The migration reads MySQL, not SQL text, so something has to stand the dump
 * up first. On a developer machine that is `sim/docker-compose.yml` mounting the
 * file into `docker-entrypoint-initdb.d`. On the server there is no `mysql`
 * client binary in the image and no way to run one, but `mysql2` is already a
 * dependency of this package and ships in the production image.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createConnection, type Connection } from 'mysql2/promise';
import { mysqlRows, report, type Config } from './db.js';

/**
 * ponytail: the whole dump is handed to MySQL as one multi-statement query.
 *
 * The alternative is splitting it here, and splitting SQL correctly means a
 * tokenizer that knows quoting, escapes and comments -- a parser whose bugs
 * would corrupt customer data silently. MySQL already has one. The cost is that
 * the file must fit in a single packet, so the size is checked rather than
 * discovered: a dump above the limit fails with an instruction instead of a
 * truncated import. The 2026-08-11 production dump is 5.84 MB.
 *
 * If dumps ever outgrow this, raise `max_allowed_packet` on the scratch server
 * and this limit with it; do not add a splitter.
 */
const MAX_DUMP_BYTES = 48 * 1024 * 1024;

export interface LoadedDump {
  /** The scratch database the dump now lives in. */
  database: string;
  bytes: number;
  /** Of the decompressed SQL, so an import can name the exact file it read. */
  sha256: string;
  tables: number;
}

function readDump(path: string): Buffer {
  const raw = readFileSync(path);
  if (!path.endsWith('.gz')) return raw;
  // gzip magic, checked rather than trusted to the extension.
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
    throw new Error(`${path} ends in .gz but is not gzip data`);
  }
  return gunzipSync(raw);
}

/**
 * Drops and recreates `database`, then runs the dump into it.
 *
 * Dropping first is the point: a scratch database that kept rows from a previous
 * file would let two different dumps merge into one source, and every count the
 * migration verifies would then be measured against something that never
 * existed. The scratch database is never the platform's own -- it holds the
 * legacy copy being read.
 */
export async function loadDump(cfg: Config, dumpPath: string): Promise<LoadedDump> {
  const size = statSync(dumpPath).size;
  if (size > MAX_DUMP_BYTES) {
    throw new Error(
      `dump is ${size} bytes, over the ${MAX_DUMP_BYTES} limit this loader accepts. ` +
        'Raise max_allowed_packet on the scratch MySQL and MAX_DUMP_BYTES together.',
    );
  }

  const sql = readDump(dumpPath).toString('utf8');
  const database = cfg.mysql.database;
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`refusing to use ${JSON.stringify(database)} as a database name`);
  }

  report.title(`loading ${dumpPath}`);
  report.step(`${sql.length} bytes of SQL into scratch database ${database}`);

  // Connected with no database selected, because the one we are about to drop
  // cannot be the one we are connected to.
  const root: Connection = await createConnection({
    host: cfg.mysql.host,
    port: cfg.mysql.port,
    user: cfg.mysql.user,
    password: cfg.mysql.password,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  try {
    await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await root.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await root.changeUser({ database });
    await root.query(sql);

    const counted = await mysqlRows<{ n: number }>(
      root,
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [database],
    );
    const tables = Number(counted[0]?.n ?? 0);
    if (tables === 0) throw new Error('the dump loaded but produced no tables');
    report.ok(`${tables} table(s) loaded`);

    return {
      database,
      bytes: size,
      sha256: createHash('sha256').update(sql).digest('hex'),
      tables,
    };
  } finally {
    await root.end();
  }
}
