/**
 * Where the sign of an expense lives, judged against the admin's own books.
 *
 * The importer used to carry a comment saying «`type` decides the sign;
 * `amount` is stored unsigned» and negate whenever `type === 'subtract'`. Both
 * halves were wrong and they cancelled each other out: nothing is typed
 * `subtract` — the word is `deduct` — so the branch never ran and the
 * already-signed amounts went through untouched. A false comment guarding dead
 * code and producing the right answer.
 *
 * That is the most dangerous shape a bug can have, because the obvious repair
 * makes it real. Correcting the typo to `deduct` looks like a one-character
 * tidy-up and flips 99 rows, moving the shop's reported income by twice the
 * deductions — with the row count, and every other total in `verify`,
 * still green.
 *
 * So this file measures the property the importer actually depends on, from the
 * data rather than from our own constants, and pins the code to not reintroduce
 * the negation. The strongest assertion is the last one: the sum of the log
 * equals `setting.revenue_adjustment`, the number the legacy panel prints,
 * arrived at without reference to how we read these rows.
 *
 * The dump is real customer data: gitignored, stays on this machine, and
 * nothing below prints a note — only signs, counts and totals.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { tomanToIrr } from '../src/transform.js';

interface Row {
  type: string;
  amount: string;
}

interface Loaded {
  rows: Row[];
  settingTotal: bigint;
  unreachable: string | null;
}

async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  const empty = { rows: [], settingTotal: 0n };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      // COLLATE utf8mb4_bin on `type`: MySQL's default collation would fold
      // `Deduct` and `deduct` together, and the importer compares in JavaScript,
      // which does not.
      const [rows] = await conn.query(
        `SELECT type COLLATE utf8mb4_bin AS type, amount FROM revenue_adjustment_log`,
      );
      const [settingRows] = await conn.query(`SELECT revenue_adjustment AS v FROM setting LIMIT 1`);
      return {
        rows: rows as Row[],
        settingTotal: BigInt((settingRows as { v: string | number }[])[0]?.v ?? 0),
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[revenue-adjustments.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { ...empty, unreachable: why };
  }
}

const { rows, settingTotal, unreachable } = await load();

describe.skipIf(unreachable !== null)('the sign of a revenue adjustment', () => {
  it('is carried by the amount, not by the type', () => {
    // The property the importer depends on, stated as the data states it. If a
    // later dump ever stores a magnitude with the sign in `type`, this is what
    // goes red — before the import runs, not after the books have moved.
    const deducts = rows.filter((r) => r.type === 'deduct');
    const adds = rows.filter((r) => r.type === 'add');
    expect(deducts.length, 'deduct rows').toBeGreaterThan(0);
    expect(adds.length, 'add rows').toBeGreaterThan(0);
    expect(deducts.length + adds.length, 'no third type').toBe(rows.length);

    expect(
      deducts.every((r) => BigInt(r.amount) < 0n),
      'every deduct is negative',
    ).toBe(true);
    expect(
      adds.every((r) => BigInt(r.amount) > 0n),
      'every add is positive',
    ).toBe(true);
  });

  it('is never spelled the word the importer used to test for', () => {
    // The dead branch's condition. It has never matched a row, which is the
    // only reason the wrong comment above it never cost anything.
    expect(rows.some((r) => r.type === 'subtract')).toBe(false);
  });

  it('is not negated again on the way in', () => {
    // Read as text because `migrateOps` needs a live MySQL and a live Postgres
    // to run, so nothing else in this package can see what the importer does
    // with the sign. Correcting `subtract` to `deduct` is the repair this whole
    // file exists to stop, and it would look like a typo fix in review.
    const source = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    const block = source.slice(
      source.indexOf("'revenue_adjustments',"),
      source.indexOf('// payment hub (D1 export)'),
    );
    expect(block).not.toBe('');
    expect(block).toContain('t.tomanToIrr(r.amount).toString()');
    expect(block).not.toMatch(/-\s*magnitude/);
    expect(block).not.toMatch(/r\.type\s*===/);
  });

  it('adds up to the number the legacy panel prints', () => {
    // The outside truth. `setting.revenue_adjustment` is maintained by the PHP
    // panel alongside the log and read straight out by revenue_history.php:56;
    // it is the same total arrived at by a route that knows nothing about our
    // mapping. Exact equality in IRR, because this is money — the same rule
    // `verify.ts` enforces, checked here before a migration is ever run.
    const imported = rows.reduce((sum, r) => sum + tomanToIrr(r.amount), 0n);
    expect(imported).toBe(settingTotal * 10n);
  });
});
