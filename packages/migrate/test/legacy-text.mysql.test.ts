/**
 * `type Row` stopped lying — and this is what keeps it honest.
 *
 * ## What the lie was
 *
 * `Record<string, string | null>` for months. mysql2 does not return every
 * column as a string, and the one time it mattered it cost 963 customers their
 * rules gate (`legacy-flags.mysql.test.ts` is that bug). The comment above the
 * type admitted the problem and declined to fix it, on the grounds that each of
 * the 48 sites needed a decision rather than a cast. That was right, and the
 * decisions are now made: `legacyText` for almost everything, and a stricter
 * rule for the two columns where a number cannot survive the trip.
 *
 * ## Why this file talks to MySQL
 *
 * Because the decision is a claim about the dump, and the dump is the only
 * thing that can confirm it. `Row` says a cell is `string | number | null`, and
 * the reason `object` is not in that union is that the four `json` columns are
 * never read. Both halves are asserted here against `information_schema` — the
 * project's sixth rule, which the first version of this repair broke twice: the
 * driver was assumed to hand back `Date`s it does not, and `D1DatabaseSession`
 * was assumed to lack a `batch` it has.
 *
 * The dump is real customer data: gitignored, stays on this machine, and
 * nothing below prints a value from it beyond a type name and a count. CI has
 * no MySQL, so there this skips with a warning; anywhere else an unreachable
 * database FAILS, because "sim is down" and "the importer is broken" must not
 * look alike.
 */

import { describe, expect, it } from 'vitest';
import { connectMysql, loadConfig } from '../src/db.js';
import { cardDigits, legacyText, phone, tehranString, username } from '../src/transform.js';
import { productionDumpAbsent } from './helpers/productionDump.js';

interface Shape {
  /** `typeof` of a real value, per SQL data type, through the real connection. */
  jsTypeOf: Record<string, string>;
  /** The `json` columns in the dump, `table.column`. */
  jsonColumns: string[];
  unreachable: string | null;
}

async function load(): Promise<Shape> {
  const empty = { jsTypeOf: {}, jsonColumns: [] };
  // Before the connection, not after. `describe.skipIf` is evaluated during
  // collection, and a loader that connects first throws during collection —
  // which vitest reports as a FAILED FILE, not a skipped one. See
  // `helpers/productionDump.ts`.
  const dumpMissing = productionDumpAbsent();
  if (dumpMissing !== null) return { ...empty, unreachable: dumpMissing };
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return { ...empty, unreachable: 'no migration config in the environment' };
  }
  try {
    // The migration's own connection, not a fresh one with default options.
    // `dateStrings` and `bigNumberStrings` are half of what decides these
    // answers, so a test that opened its own would be measuring a driver the
    // importer never uses.
    const my = await connectMysql(cfg);
    try {
      const [cols] = await my.query(
        `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE dt FROM information_schema.columns
          WHERE TABLE_SCHEMA = ? ORDER BY DATA_TYPE, TABLE_NAME, ORDINAL_POSITION`,
        [cfg.mysql.database],
      );
      const all = cols as { t: string; c: string; dt: string }[];

      const jsTypeOf: Record<string, string> = {};
      for (const { t, c, dt } of all) {
        if (jsTypeOf[dt] !== undefined) continue;
        const [rows] = await my.query(
          `SELECT \`${c}\` AS v FROM \`${t}\` WHERE \`${c}\` IS NOT NULL LIMIT 1`,
        );
        const seen = rows as { v: unknown }[];
        if (seen.length > 0) jsTypeOf[dt] = typeof seen[0]!.v;
      }

      return {
        jsTypeOf,
        jsonColumns: all.filter((x) => x.dt === 'json').map((x) => `${x.t}.${x.c}`),
        unreachable: null,
      };
    } finally {
      await my.end();
    }
  } catch (err) {
    if (process.env['CI']) {
      console.warn('legacy-text: no MySQL in CI, skipping');
      return { ...empty, unreachable: 'CI has no dump' };
    }
    throw err;
  }
}

const shape = await load();
/**
 * These assertions are about the REAL Mirzabot dataset — row counts, actual
 * discount codes, the 963 customers who never accepted the rules. They only
 * mean anything against the production dump, so they are gated on a person
 * saying that is what this database is.
 *
 * The gate used to be «can I reach a MySQL», which was a proxy for the same
 * thing right up until `synthetic-migration.test.ts` started loading a
 * synthetic legacy database in CI. Then a MySQL was reachable on a runner,
 * these un-skipped, and failed on `expected 2 to be 31` — correctly. See
 * `helpers/productionDump.ts`.
 */
const dumpAbsent = productionDumpAbsent();

const withDump =
  shape.unreachable === null && dumpAbsent === null ? describe : describe.skip;
if (shape.unreachable !== null) console.warn(`legacy-text: skipped — ${shape.unreachable}`);

withDump('what the driver hands back, asked of the driver', () => {
  it('returns a number for exactly the two integer types, and text for the rest', () => {
    // `Row` is `string | number | null`. This is the whole of the evidence for
    // that union: any SQL type answering something else is a column the type
    // does not describe, and the failure names it.
    const unexpected = Object.entries(shape.jsTypeOf).filter(([dt, js]) => {
      if (dt === 'int' || dt === 'tinyint') return js !== 'number';
      if (dt === 'json') return js !== 'object';
      return js !== 'string';
    });
    expect(unexpected).toEqual([]);
  });

  it('keeps `bigint` and `datetime` as text, which is what the connection is configured for', () => {
    // Not decoration: `bigNumberStrings` is what stops a telegram id past 2^53
    // being rounded, and `dateStrings` is why `tehranString` parses text rather
    // than a `Date`. Both are options on a connection somebody could «tidy».
    expect(shape.jsTypeOf['bigint']).toBe('string');
    expect(shape.jsTypeOf['datetime']).toBe('string');
  });

  it('has json columns, and the migration reads none of them', async () => {
    // The reason `object` is left out of `Row`. If this list ever grows a column
    // the importer reads, the union has to widen with it.
    expect(shape.jsonColumns.length).toBeGreaterThan(0);
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/migrate.ts', import.meta.url), 'utf8'),
    );
    const read = shape.jsonColumns.filter((tc) => src.includes(`r.${tc.split('.')[1]}`));
    expect(read).toEqual([]);
  });
});

describe('legacyText decides, rather than casting', () => {
  it('passes text through untouched', () => {
    expect(legacyText('  hello ', 'f')).toBe('  hello ');
    expect(legacyText('', 'f')).toBe('');
  });

  it('treats an absent cell as absent', () => {
    expect(legacyText(null, 'f')).toBeNull();
    expect(legacyText(undefined, 'f')).toBeNull();
  });

  it('turns a safe integer into the digits MySQL had', () => {
    // An id column that changes from `varchar` to `int` on the cutover dump
    // keeps working, because these are the same ten characters.
    expect(legacyText(1000043001, 'user.id')).toBe('1000043001');
    expect(legacyText(0, 'f')).toBe('0');
  });

  it('refuses a number that cannot become its own digits exactly', () => {
    // Each of these reaches a string only by losing something, and this
    // migration moves money.
    expect(() => legacyText(1.5, 'f')).toThrow();
    expect(() => legacyText(Number.MAX_SAFE_INTEGER + 2, 'f')).toThrow();
    expect(() => legacyText(Number.NaN, 'f')).toThrow();
    expect(() => legacyText({}, 'f')).toThrow();
  });

  it('formats a Date, for the day `dateStrings` goes missing', () => {
    // Local time, matching what MySQL would have printed, and in the shape
    // `tehranString` already parses. Built from a fixed instant rather than the
    // clock (rule 5).
    const d = new Date(2026, 6, 7, 20, 7, 53);
    expect(legacyText(d, 'f')).toBe('2026-07-07 20:07:53');
    expect(tehranString(d, 'revenue_adjustment_log.created_at')).toBe('2026/07/07 20:07:53');
  });
});

describe('the two columns where a number is never acceptable', () => {
  it('refuses a numeric phone, because the leading zero is already gone', () => {
    // «۹۱۲…» instead of «۰۹۱۲…» is invisible in a table of 11,241 rows, and
    // nothing downstream can tell the two apart.
    expect(() => phone(9121234567)).toThrow();
    expect(phone('09121234567')).toBe('09121234567');
  });

  it('refuses a numeric card, because a 16-digit card is past 2^53', () => {
    // It arrives already rounded. `isLuhnValid` exists because one wrong digit
    // is exactly what this migration had to settle once before.
    expect(() => cardDigits(6037991234567890)).toThrow();
    expect(cardDigits('6037-9912-3456-7890')).toBe('6037991234567890');
  });

  it('still lets a numeric id through where nothing is lost', () => {
    // The control: a rule that refused every number would pass both assertions
    // above and break the ordinary case the widening exists to allow.
    expect(username(12345)).toBe('12345');
  });
});
