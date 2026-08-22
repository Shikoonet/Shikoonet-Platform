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

interface Loaded {
  /** How many customers hold each `roll_Status` value. */
  rollStatus: Record<string, number>;
  total: number;
  /** Column names on the legacy `user` table. */
  columns: string[];
  unreachable: string | null;
}

async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  const empty = { rollStatus: {}, total: 0, columns: [] };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      const [rollRows] = await conn.query(
        `SELECT roll_Status AS k, COUNT(*) AS n FROM user GROUP BY roll_Status`,
      );
      const [totalRows] = await conn.query(`SELECT COUNT(*) AS n FROM user`);
      const [colRows] = await conn.query(`SHOW COLUMNS FROM user`);
      return {
        rollStatus: Object.fromEntries(
          (rollRows as { k: unknown; n: number }[]).map((r) => [String(r.k), Number(r.n)]),
        ),
        total: Number((totalRows as { n: number }[])[0]?.n ?? 0),
        columns: (colRows as { Field: string }[]).map((c) => c.Field),
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[customer-columns.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { ...empty, unreachable: why };
  }
}

const { rollStatus, total, columns, unreachable } = await load();

describe.skipIf(unreachable !== null)('roll_Status is a gate, not a preference', () => {
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
