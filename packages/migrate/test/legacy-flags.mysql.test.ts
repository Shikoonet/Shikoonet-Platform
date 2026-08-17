/**
 * The legacy 0/1 flags, judged by what the MySQL driver actually hands over.
 *
 * ## The bug this exists for
 *
 * `migrate.ts` read `r.roll_Status !== '0'` — a strict comparison against the
 * *string* `'0'`. `user.roll_Status` is `tinyint(1)`, mysql2 returns it as a
 * **number**, and `0 !== '0'` is `true`. So all 963 customers who never accepted
 * the shop's rules would have migrated in as having accepted them, and walked
 * straight past the gate on their first message after the cutover.
 *
 * ## Why nothing caught it
 *
 * `gates.mysql.test.ts` knew both halves and never joined them: it asserts that
 * 963 unaccepted rows exist, and separately that the source file contains the
 * string `'rules_accepted'`. The second is a grep over `migrate.ts`, not a claim
 * about any value — so the column could have been filled with anything at all
 * and the suite stayed green. `type Row = Record<string, string | null>` then
 * told the compiler every field was a string, which is why `0 !== '0'` never
 * looked like the type error it is.
 *
 * The lesson is the project's sixth rule with a new example: a test that reads
 * the code rather than the behaviour agrees with itself for ever.
 *
 * ## What is asserted here
 *
 * The driver's own output, converted by the same function the migration calls.
 * No fixture stringifies anything on the way in — that coercion is precisely
 * what hid this. `legacyBool` throws on anything outside the domain, so a third
 * column joining this family fails loudly rather than defaulting.
 *
 * The dump is real customer data: gitignored, stays on this machine, and nothing
 * below prints a value from it beyond a count and a type name. CI has no MySQL,
 * so there this skips with a warning; anywhere else an unreachable database
 * FAILS, because "sim is down" and "the importer is broken" must not look alike.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { legacyBool } from '../src/transform.js';

interface Sample {
  /** `typeof` of the value the driver returned, per column. */
  types: Record<string, string>;
  /** Distinct raw values seen, per column. */
  values: Record<string, unknown[]>;
  notAccepted: number;
  unreachable: string | null;
}

async function load(): Promise<Sample> {
  const empty = { types: {}, values: {}, notAccepted: 0 };
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return { ...empty, unreachable: 'no migration config in the environment' };
  }
  try {
    const my = await createConnection(cfg.mysql);
    try {
      const types: Record<string, string> = {};
      const values: Record<string, unknown[]> = {};
      for (const [table, column] of [
        ['user', 'roll_Status'],
        ['reagent_report', 'get_gift'],
      ] as const) {
        const [rows] = await my.query(
          `SELECT DISTINCT \`${column}\` AS v FROM \`${table}\` ORDER BY v`,
        );
        const seen = (rows as { v: unknown }[]).map((r) => r.v);
        values[`${table}.${column}`] = seen;
        types[`${table}.${column}`] = seen.length > 0 ? typeof seen[0] : '(no rows)';
      }
      const [pending] = await my.query(`SELECT COUNT(*) AS n FROM user WHERE roll_Status = 0`);
      return {
        types,
        values,
        notAccepted: Number((pending as { n: number }[])[0]?.n ?? 0),
        unreachable: null,
      };
    } finally {
      await my.end();
    }
  } catch (err) {
    if (process.env['CI']) {
      console.warn('legacy-flags: no MySQL in CI, skipping');
      return { ...empty, unreachable: 'CI has no dump' };
    }
    throw err;
  }
}

const { types, values, notAccepted, unreachable } = await load();

describe.skipIf(unreachable !== null)('legacy 0/1 flags', () => {
  it('arrive from the driver as numbers, not strings', () => {
    // The fact the whole bug rests on. If a future mysql2 or a changed
    // `typeCast` starts returning strings, `legacyBool` still copes — but this
    // going red is how we learn the ground moved.
    expect(types['user.roll_Status']).toBe('number');
    expect(types['reagent_report.get_gift']).toBe('number');
  });

  it('hold only values the converter claims to understand', () => {
    // A third value in production would mean the domain is wider than the map,
    // and `legacyBool` would throw during the migration rather than here.
    for (const [column, seen] of Object.entries(values)) {
      for (const v of seen) {
        expect(() => legacyBool(v, column), `${column} = ${JSON.stringify(v)}`).not.toThrow();
      }
    }
  });

  it('converts every unaccepted customer to false', () => {
    // The assertion the old test never made. `notAccepted` is 963 on the
    // 2026-08-11 dump; the number is read rather than written down because the
    // dump is retaken at cutover.
    expect(notAccepted).toBeGreaterThan(0);
    const raw = values['user.roll_Status'] ?? [];
    expect(raw).toContain(0);
    expect(legacyBool(0, 'user.roll_Status')).toBe(false);
    // And the shape the migration used to have, kept as the counter-example: it
    // is what turned 963 refusals into acceptances.
    expect(0 !== ('0' as unknown)).toBe(true);
  });

  it('converts a claimed referral gift to true', () => {
    // Today every `reagent_report` row is 0, so the old `=== '1'` produced the
    // right answer by luck. The dump is retaken at cutover, and one customer
    // claiming a bonus before then would have migrated as unclaimed — and been
    // paid a second time.
    expect(legacyBool(1, 'reagent_report.get_gift')).toBe(true);
    expect(legacyBool(0, 'reagent_report.get_gift')).toBe(false);
  });
});
