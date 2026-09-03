/**
 * Where each customer column lands, judged against the production dump.
 *
 * This file exists because of one mis-mapping that no unit test could see:
 * `user.roll_Status` — "has accepted the shop rules" — was written into
 * `users.notify_enabled`, the only column gating both expiry warnings
 * (`warn.ts:80,94`). Every one of the 963 customers holding `0` would have
 * arrived unable to be told their service was ending. Nobody reports a message
 * that never arrives, and a test built from our own column list would have
 * agreed with the mistake.
 *
 * So the assertions here are about the SHAPE of the real data: the value in
 * MySQL, the meaning of the Postgres column it is written to, and whether those
 * two can be the same thing. A boolean landing in the nearest boolean column is
 * exactly the failure being guarded against.
 *
 * The dump is real customer data: gitignored, stays on this machine, and
 * nothing below prints a value from it — only counts.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { productionDumpAbsent } from './helpers/productionDump.js';

interface Loaded {
  /** How many customers hold each `roll_Status` value. */
  rollStatus: Record<string, number>;
  /**
   * How many customers hold each `agent` value — the reseller tier.
   *
   * `COLLATE utf8mb4_bin`, because MySQL's default collation is
   * case-insensitive and would fold an `N` into `n`. That is CLAUDE.md rule 7
   * exactly: a pre-flight that groups more loosely than the code it is
   * checking reports a domain the migration will then choke on.
   */
  agent: Record<string, number>;
  total: number;
  /** Column names on the legacy `user` table. */
  columns: string[];
  unreachable: string | null;
}

async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  const empty = { rollStatus: {}, agent: {}, total: 0, columns: [] };
  // Before the connection, not after. `describe.skipIf` is evaluated during
  // collection, and a loader that connects first throws during collection —
  // which vitest reports as a FAILED FILE, not a skipped one. See
  // `helpers/productionDump.ts`.
  const dumpMissing = productionDumpAbsent();
  if (dumpMissing !== null) return { ...empty, unreachable: dumpMissing };
  /*
   * The catch below covers the CONNECTION only, and that boundary is the point.
   *
   * It used to wrap the queries too, so on a runner with the dump present a
   * broken query — a renamed column, a collation MySQL refuses — came back as
   * «simulation MySQL unreachable» and every assertion here skipped. «The
   * database is not there» and «the check itself is broken» would have looked
   * identical, and only one of them is safe to walk past. Found by CodeRabbit
   * on PR #87.
   */
  let conn;
  try {
    conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[customer-columns.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { ...empty, unreachable: why };
  }

  {
    try {
      const [rollRows] = await conn.query(
        `SELECT roll_Status AS k, COUNT(*) AS n FROM user GROUP BY roll_Status`,
      );
      const [agentRows] = await conn.query(
        `SELECT agent COLLATE utf8mb4_bin AS k, COUNT(*) AS n FROM user GROUP BY k`,
      );
      const [totalRows] = await conn.query(`SELECT COUNT(*) AS n FROM user`);
      const [colRows] = await conn.query(`SHOW COLUMNS FROM user`);
      return {
        rollStatus: Object.fromEntries(
          (rollRows as { k: unknown; n: number }[]).map((r) => [String(r.k), Number(r.n)]),
        ),
        agent: Object.fromEntries(
          (agentRows as { k: unknown; n: number }[]).map((r) => [String(r.k), Number(r.n)]),
        ),
        total: Number((totalRows as { n: number }[])[0]?.n ?? 0),
        columns: (colRows as { Field: string }[]).map((c) => c.Field),
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  }
}

const { rollStatus, agent, total, columns, unreachable } = await load();

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

describe.skipIf(unreachable !== null || dumpAbsent !== null)('roll_Status is a gate, not a preference', () => {
  it('is a two-valued flag on a real fraction of the customers', () => {
    // Both values present, and the "not accepted" side big enough that sending
    // it to the wrong column costs real customers. If a later dump has everyone
    // on one value this goes red and somebody re-reads why the column exists.
    const values = Object.keys(rollStatus).sort();
    expect(values).toEqual(['0', '1']);
    expect(rollStatus['0']).toBeGreaterThan(100);
    expect(rollStatus['1']).toBeGreaterThan(rollStatus['0']!);
    expect(rollStatus['0']! + rollStatus['1']!).toBe(total);
  });

  it('is not a notification preference, because the schema has none', () => {
    // The reason the old mapping was wrong rather than merely odd: there is no
    // column on the legacy customer that says "do not message me". `index.php`
    // warns everybody. So `users.notify_enabled` has nothing to be imported
    // from and must keep its own default — importing ANY legacy boolean into it
    // switches warnings off for whichever customers happen to hold a zero.
    const notification = columns.filter((c) => /notif|silent|mute|unsubscrib/i.test(c));
    expect(notification).toEqual([]);
  });

  it('is imported into a column named after what it means', () => {
    // The importer's own source, read as text. Nothing else in this package can
    // see the destination — `migrateUsers` needs a live MySQL and a live
    // Postgres to run — so a rename pointing this back at `notify_enabled`
    // would pass every other test here and quietly lose 963 customers their
    // expiry warnings. The same trick `bot-text-lines.test.ts` uses to prove a
    // registry key is actually read.
    expect(columns).toContain('roll_Status');

    const source = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    const userCols = source.slice(
      source.indexOf("    'users',"),
      source.indexOf("{ conflict: '(telegram_id)' }"),
    );
    expect(userCols).not.toBe('');
    expect(userCols).toContain("'rules_accepted'");
    // The column the warning sweep reads. It has nothing to be imported from
    // and must keep its own default; naming it here at all is the bug.
    expect(userCols).not.toContain("'notify_enabled'");
  });
});

/**
 * The reseller tier, and the two facts that decide whether it needs a re-import.
 *
 * `is_reseller` is a boolean and folds 'n' and 'n2' onto it; `agent` sits in the
 * importer's `claimed` list, so it does not reach `legacy_attrs` either. Until
 * 2026-09-04 the tier was therefore LOST at import, and the panel reads
 * `COALESCE(u.reseller_tier, 'n')` — every reseller is level one whether or not
 * that is true.
 *
 * Whether that silence cost anything is a question about the DATA, not the code,
 * and the dump answers it: 11,240 customers on 'f', exactly one on 'n', and no
 * 'n2' at all. So the fallback has been returning the right answer for the only
 * reseller that exists, and a repair pass over existing rows would change
 * nothing. The importer now carries the column for the day that stops being
 * true — and this test is what notices that day.
 */
describe.skipIf(unreachable !== null || dumpAbsent !== null)('the reseller tier', () => {
  it('has only the three values index.php:299 allows', () => {
    // A fourth value would be a wrong price, silently: `isReseller` throws on
    // it, so the migration stops — which is the design, and this says so before
    // the migration has to.
    expect(Object.keys(agent).every((v) => ['f', 'n', 'n2'].includes(v))).toBe(true);
    expect(Object.values(agent).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('carries no second-tier reseller today — which is why no back-fill is owed', () => {
    // The whole argument for not re-importing, written down so the next person
    // does not have to re-derive it. If a dump ever DOES carry an 'n2', this
    // goes red and the answer changes: those rows need the column filled, not
    // the default.
    expect(agent['n2'] ?? 0).toBe(0);
    expect(agent['n'] ?? 0).toBeGreaterThan(0);
  });

  it('is written by the importer, into a column of its own', () => {
    // The same source-text check `roll_Status` uses, and for the same reason:
    // nothing else in this package can see the destination. A rename or a
    // dropped column would otherwise pass every test here and lose the tier
    // again, in silence.
    const source = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    const userCols = source.slice(
      source.indexOf("    'users',"),
      source.indexOf("{ conflict: '(telegram_id)' }"),
    );
    expect(userCols).toContain("'reseller_tier'");
    expect(source).toContain('t.resellerTier(r.agent)');
    // And the boolean stays beside it. Seventeen call sites read `is_reseller`;
    // the tier is a second column, not a replacement.
    expect(userCols).toContain("'is_reseller'");
  });
});
