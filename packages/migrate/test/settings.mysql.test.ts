/**
 * The settings import, judged against the production dump.
 *
 * The point is not that the eight key names I already know about are filtered —
 * a test asserting that would agree with the list it was written from. It is
 * that **no value that looks like a credential survives the import**, whatever
 * its key is called. So every real `PaySetting` row is run through the filter,
 * and for each one that would be imported the *value* is checked against the
 * shapes a credential takes. A ninth gateway key nobody remembered fails here.
 *
 * The dump is real customer data: gitignored, stays on this machine, and
 * nothing below prints a value from it. Assertions name keys, never values.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the filter is broken" must not look the same.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { isSettingSecret } from '../src/migrate.js';
import { productionDumpAbsent } from './helpers/productionDump.js';

type Row = Record<string, string | null>;

/**
 * What a credential looks like when you cannot look at it.
 *
 * A JWT; a long unbroken run of base64/hex with no spaces; a TRON or Ethereum
 * style wallet address. A switch is `on`/`off`, a limit is digits, and a help
 * text has spaces — none of them reach twenty unbroken token characters.
 */
const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ['a JWT', /eyJ[A-Za-z0-9_-]{10,}\./],
  ['a long opaque token', /^[A-Za-z0-9_\-:.]{20,}$/],
  ['a TRON address', /^T[A-Za-z0-9]{25,}$/],
  ['an Ethereum address', /^0x[a-fA-F0-9]{30,}$/],
];

function looksLikeCredential(value: string): string | null {
  const v = value.trim();
  // A plain number is a limit or a percentage, however long.
  if (/^[0-9]+$/.test(v)) return null;
  for (const [name, shape] of CREDENTIAL_SHAPES) if (shape.test(v)) return name;
  return null;
}

async function loadPaySettings(): Promise<{ rows: Row[]; unreachable: string | null }> {
  const cfg = loadConfig();
  // Before the connection, not after. `describe.skipIf` is evaluated during
  // collection, and a loader that connects first throws during collection —
  // which vitest reports as a FAILED FILE, not a skipped one. See
  // `helpers/productionDump.ts`.
  const dumpMissing = productionDumpAbsent();
  if (dumpMissing !== null) return { ...{ rows: [] }, unreachable: dumpMissing };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      const [result] = await conn.query('SELECT NamePay, ValuePay FROM PaySetting');
      return { rows: result as Row[], unreachable: null };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[settings.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { rows: [], unreachable: why };
  }
}

const { rows, unreachable } = await loadPaySettings();

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

describe.skipIf(unreachable !== null || dumpAbsent !== null)('the settings import, against the real PaySetting table', () => {
  it('has rows to judge', () => {
    // Otherwise every assertion below is vacuously true.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('lets no credential-shaped value through the filter', () => {
    const leaked: string[] = [];
    for (const r of rows) {
      const key = String(r.NamePay ?? '');
      // `noUncheckedIndexedAccess`: a column absent from the row is undefined,
      // not null, and both mean "nothing to judge here".
      const value = r.ValuePay ?? null;
      if (value === null || value.trim() === '') continue;
      if (isSettingSecret('pay', key)) continue;
      const shape = looksLikeCredential(value);
      // The key, never the value.
      if (shape) leaked.push(`${key} (${shape})`);
    }
    expect(leaked).toEqual([]);
  });

  it('drops every key the dump actually uses for a gateway credential', () => {
    // Named explicitly so that a filter loosened later fails here rather than
    // quietly starting to import them again.
    for (const key of [
      'apiiranpay',
      'apinowpayment',
      'apiternado',
      'merchant_id_aqayepardakht',
      'merchant_zarinpal',
      'marchent_floypay',
      'marchent_tronseller',
      'walletaddress',
    ]) {
      expect(isSettingSecret('pay', key)).toBe(true);
    }
  });

  it('keeps the settings that are limits and switches', () => {
    for (const key of ['maxbalancecart', 'minbalance', 'cardnumber', 'namecard', 'Cartstatus']) {
      expect(isSettingSecret('pay', key)).toBe(false);
    }
  });

  it('does not filter the bot and shop scopes, which hold no credentials', () => {
    // `setting` and `shopSetting` are switches and numbers throughout — checked
    // column by column on 2026-08-14. Filtering them would silently drop real
    // configuration.
    expect(isSettingSecret('bot', 'apikey')).toBe(false);
    expect(isSettingSecret('shop', 'statusshowprice')).toBe(false);
  });
});
