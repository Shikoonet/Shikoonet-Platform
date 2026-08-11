/**
 * Every SQL statement the payment hub ships must survive translation and be
 * parseable by the new Postgres schema.
 *
 * This is the test that sizes the port. It extracts each SQL literal from
 * legacy/hub-cloudflare, runs it through the dialect translator, and asks
 * Postgres to PREPARE it. A statement that references a column the schema does
 * not have, or uses syntax Postgres rejects, fails here — before anyone tries
 * to run it against real money.
 *
 * It is a static check, not a behavioural one: PREPARE proves the statement is
 * valid against the schema, not that it returns the right rows. The behavioural
 * proof is the hub's own test suite, ported in the next step.
 *
 * Retired in phase 5 along with legacy/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '../src/index.js';
import { toPostgres } from '../src/dialect.js';

const HUB = new URL('../../../legacy/hub-cloudflare', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

/**
 * SQL fragments that are interpolated into a larger query and are not valid on
 * their own — they reference an alias bound by the outer statement. Listed
 * explicitly so a genuinely broken statement can never hide among them.
 */
const KNOWN_FRAGMENTS = [
  // financialAnalytics.SALE_CLAIM_WHERE and friends: correlated on `c`, the
  // payment_claims alias supplied by the enclosing query.
  'FROM reconciliation_matches m2 WHERE m2.payment_claim_id = c.id',
];

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

/** Removes comments so a backtick-quoted phrase in JSDoc is not read as SQL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Statement {
  file: string;
  sql: string;
}

function collect(): { standalone: Statement[]; interpolated: number; fragments: number } {
  const roots = [join(HUB, 'packages'), join(HUB, 'apps')].filter(existsSync);
  const files = roots
    .flatMap((r) => walk(r))
    .filter((f) => f.includes(`${join('', 'src', '')}`) || /[\\/]src[\\/]/.test(f));

  const standalone: Statement[] = [];
  let interpolated = 0;
  let fragments = 0;

  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/gs)) {
      const sql = m[1] ?? '';
      if (!SQL_START.test(sql)) continue;
      if (sql.includes('${')) { interpolated++; continue; }
      // Compare on collapsed whitespace: these literals are multi-line.
      const flat = sql.replace(/\s+/g, ' ');
      if (KNOWN_FRAGMENTS.some((f) => flat.includes(f))) { fragments++; continue; }
      standalone.push({ file: file.replace(HUB, '').replace(/\\/g, '/'), sql });
    }
  }
  return { standalone, interpolated, fragments };
}

const hubPresent = existsSync(join(HUB, 'packages'));
const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!hubPresent)('every hub SQL statement is portable', () => {
  const { standalone, interpolated, fragments } = hubPresent
    ? collect()
    : { standalone: [], interpolated: 0, fragments: 0 };

  it('found the hub source to check', () => {
    // A silent zero would make this whole file pass while proving nothing.
    expect(standalone.length).toBeGreaterThan(200);
    console.log(
      `  ${standalone.length} standalone statements, ` +
        `${interpolated} interpolated (skipped), ${fragments} known fragments`,
    );
  });

  it('translates and parses all of them against the new schema', async () => {
    const failures: { file: string; sql: string; error: string }[] = [];
    let n = 0;

    for (const { file, sql } of standalone) {
      let translated: string;
      try {
        translated = toPostgres(sql);
      } catch (err) {
        failures.push({ file, sql, error: `translate: ${(err as Error).message}` });
        continue;
      }

      try {
        await db.prepare('BEGIN').run();
        await db.prepare(`PREPARE hub_probe_${n++} AS ${translated}`).run();
        await db.prepare('ROLLBACK').run();
      } catch (err) {
        await db.prepare('ROLLBACK').run().catch(() => undefined);
        const e = err as { code?: string; message: string };
        // 42P18: Postgres cannot infer a type for a bare parameter. The
        // statement is syntactically valid and resolves against the schema;
        // only the inference is undecidable without context.
        if (e.code === '42P18') continue;
        failures.push({
          file,
          sql: sql.replace(/\s+/g, ' ').slice(0, 140),
          error: `${e.code ?? '?'} ${e.message}`,
        });
      }
    }

    if (failures.length > 0) {
      const report = failures
        .map((f) => `\n  ${f.file}\n    ${f.error}\n    ${f.sql}`)
        .join('\n');
      throw new Error(`${failures.length} hub statement(s) are not portable:${report}`);
    }
    expect(failures).toHaveLength(0);
  });
});
