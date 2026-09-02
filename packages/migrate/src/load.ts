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
/**
 * Exported since 2026-09-01, because the panel now accepts an upload and the
 * request has to be refused at the same number the loader would refuse it at.
 * A second constant in `importRoutes.ts` would let a 60 MB file be accepted,
 * written to disk, and only then rejected by the step after.
 */
export const MAX_DUMP_BYTES = 48 * 1024 * 1024;

export interface LoadedDump {
  /** The scratch database the dump now lives in. */
  database: string;
  bytes: number;
  /** Of the decompressed SQL, so an import can name the exact file it read. */
  sha256: string;
  tables: number;
}

/**
 * The dump as SQL bytes, bounded on the way out as well as on the way in.
 *
 * `loadDump` checks `statSync().size`, which for a `.gz` is the COMPRESSED
 * size — and a 5 MB dump of repetitive SQL expands to hundreds of megabytes.
 * Without a bound here that whole payload is allocated, converted to a UTF-8
 * string and handed to MySQL as one packet, so the limit that exists to keep
 * this loader inside `max_allowed_packet` was enforced against the wrong
 * number. Found by CodeRabbit on PR #42.
 *
 * `maxOutputLength` makes zlib stop rather than us measure afterwards: checking
 * `.length` after `gunzipSync` would mean the allocation has already happened,
 * which is the failure being prevented.
 */
export function readDump(path: string): Buffer {
  const raw = readFileSync(path);
  if (!path.endsWith('.gz')) return raw;
  // gzip magic, checked rather than trusted to the extension.
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
    throw new Error(`${path} ends in .gz but is not gzip data`);
  }
  try {
    return gunzipSync(raw, { maxOutputLength: MAX_DUMP_BYTES });
  } catch (err) {
    // zlib says «Cannot create a Buffer larger than…», which names neither the
    // file nor what to do. The instruction is the same one the size check gives.
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `${path} expands to more than the ${MAX_DUMP_BYTES} bytes this loader accepts. ` +
          'Raise max_allowed_packet on the scratch MySQL and MAX_DUMP_BYTES together.',
      );
    }
    throw err;
  }
}

/**
 * The identity of a dump: the SHA-256 of its **decompressed SQL**.
 *
 * Exported, and used by `loadDump` below, so there is exactly one definition of
 * «which dump is this». `apps/dashboard-worker` gates an APPLY on a dry run of
 * the same dump having succeeded, and it can only do that if it computes the
 * identity the same way the run recorded it. Two implementations of this hash
 * would drift the first time one of them decompressed and the other did not,
 * and the symptom would be a gate that silently stopped gating.
 *
 * The SQL and not the file bytes: a dump recompressed at a different level is
 * the same dump, and a `.sql` and its `.sql.gz` are the same dump too.
 */
export function dumpSha256(path: string): string {
  return createHash('sha256').update(readDump(path).toString('utf8')).digest('hex');
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
export async function loadDump(
  cfg: Config,
  dumpPath: string,
  /**
   * The digest the caller was AUTHORISED to load, if it has one.
   *
   * The panel gates an APPLY on a dry run of the same dump having succeeded: it
   * hashes the file, finds the run that proved those bytes, and starts the
   * import. Between the hash and this function the file can change — an upload,
   * an `scp`, a second admin — and the gate would then have proved a dump that
   * is not the one about to be read.
   *
   * CodeRabbit found that on PR #48 and asked for a reservation shared by the
   * upload route and the run route. This is smaller and it holds against more:
   * a reservation can only exclude writers that agree to take it, and this
   * directory has one that never will — `scp` is how every dump arrived before
   * the panel could upload one. So the question is not «did anybody else hold
   * the door», it is «are these the bytes I was allowed to read», asked of the
   * file that was actually read.
   *
   * Checked HERE rather than in the route because this is where the one
   * definition of dump identity lives, and checked before a single byte reaches
   * MySQL: the scratch database is dropped further down, and dropping it on
   * behalf of a file nobody approved would destroy the evidence of the run that
   * did pass.
   */
  expectSha?: string,
): Promise<LoadedDump> {
  const size = statSync(dumpPath).size;
  if (size > MAX_DUMP_BYTES) {
    throw new Error(
      `dump is ${size} bytes, over the ${MAX_DUMP_BYTES} limit this loader accepts. ` +
        'Raise max_allowed_packet on the scratch MySQL and MAX_DUMP_BYTES together.',
    );
  }

  const sql = readDump(dumpPath).toString('utf8');

  if (expectSha !== undefined) {
    const actual = createHash('sha256').update(sql).digest('hex');
    if (actual !== expectSha) {
      throw new Error(
        `${dumpPath} is not the file that was approved: expected sha256 ${expectSha}, ` +
          `found ${actual}. It changed after the check. Run a dry run again on the file as it is now.`,
      );
    }
  }

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
      // The same expression `dumpSha256` uses, over the same bytes — `sql` is
      // what `readDump` returned. Kept inline rather than re-reading the file.
      sha256: createHash('sha256').update(sql).digest('hex'),
      tables,
    };
  } finally {
    await root.end();
  }
}
