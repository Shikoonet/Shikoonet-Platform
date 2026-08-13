/**
 * What a discount code is allowed to do, judged against the production dump.
 *
 * `discount_codes` was built from the legacy tables' columns, and the columns
 * are not the rule. The rule is `index.php:4218`, which will not apply a code
 * unless its product, its panel, its date and its type all match — and until
 * 2026-08-14 the importer carried none of those four. On the 2026-08-11 dump
 * that is 31 expired codes coming back to life and 23 panel-scoped ones going
 * global.
 *
 * So the input here is the real `DiscountSell` table in the simulation MySQL,
 * from `legacy/mirzabot-php/db/mirzabot-prod-20260811.sql`. That dump is real
 * customer data: gitignored, kept on this machine, and nothing below prints a
 * value out of it — the assertions are counts and types, never a row.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { appliesTo, expiryFromLegacy } from '../src/migrate.js';

type Row = Record<string, string | null>;

async function loadCodes(): Promise<{ rows: Row[]; unreachable: string | null }> {
  const cfg = loadConfig();
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      const [result] = await conn.query('SELECT * FROM DiscountSell');
      return { rows: result as Row[], unreachable: null };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[discounts.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { rows: [], unreachable: why };
  }
}

const { rows, unreachable } = await loadCodes();

/** 2026-08-14, the day this was measured. Fixed on purpose: the point is what
 *  the dump held, not what today makes of it. */
const MEASURED_AT = Date.parse('2026-08-14T00:00:00Z');

describe.skipIf(unreachable !== null)('the real DiscountSell rows, imported', () => {
  it('finds codes to check at all', () => {
    // Without this the whole file passes vacuously on an empty table.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('keeps the dates, and most of these codes are already over', () => {
    const expired = rows.filter((r) => {
      const at = expiryFromLegacy(r['time']);
      return at !== null && Date.parse(at) < MEASURED_AT;
    });
    // Not an approximation of the dump — the count of it. If the importer ever
    // drops `time` again, this is 0 and says so.
    expect(expired.length).toBe(31);
    expect(rows.filter((r) => expiryFromLegacy(r['time']) === null).length).toBe(1);
  });

  it('reads "0" as never expires, not as 1970', () => {
    // Both are falsy in the wrong hands, and one of them ends every code.
    expect(expiryFromLegacy('0')).toBeNull();
    expect(expiryFromLegacy(null)).toBeNull();
    expect(expiryFromLegacy('1783966057')).toBe('2026-07-13T18:07:37.000Z');
  });

  it('keeps a code that is only for buying away from a renewal', () => {
    const scopes = rows.map((r) => appliesTo(r['type']));
    expect(scopes.filter((s) => s === 'BUY').length).toBe(2);
    expect(scopes.filter((s) => s === 'RENEW').length).toBe(1);
    // Every row in the dump is one of the three the PHP knows.
    expect(scopes.filter((s) => s === null).length).toBe(0);
  });

  it('refuses a type neither SELECT in the PHP would match', () => {
    // 'buy' matches when buying, 'extend' when renewing, 'all' either way, and
    // anything else matches nothing — so it must not become "everything".
    expect(appliesTo('promo')).toBeNull();
    expect(appliesTo('')).toBeNull();
    expect(appliesTo(undefined)).toBeNull();
  });

  it('has scoped codes to carry a scope for', () => {
    // If these ever read 0 the scope columns are meaningless and the two
    // lookups in the importer are dead code.
    expect(rows.filter((r) => r['code_product'] !== 'all').length).toBe(13);
    expect(rows.filter((r) => r['code_panel'] !== '/all').length).toBe(23);
  });
});
