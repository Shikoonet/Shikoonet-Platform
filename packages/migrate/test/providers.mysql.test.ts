/**
 * The provider import, judged against the production dump rather than a fixture.
 *
 * Every existing test of this path types its own input, so all of them agree
 * with the code and none of them agrees with production. That is how
 * `config.inbounds` shipped as the *string* `"[42,2]"` — MySQL hands back text,
 * `legacyAttrs` stores what it is handed, and the adapter then sends a string
 * where the panel declares a list. The panel answers 422 and nothing before
 * this file could have said so.
 *
 * So the input here is the real `marzban_panel` table in the simulation MySQL,
 * loaded from `legacy/mirzabot-php/db/mirzabot-prod-20260811.sql`. That dump is
 * real customer data: it is gitignored, it stays on this machine, and nothing
 * below prints a value from it.
 *
 * Assertions are deliberately narrow — type, key presence, pattern. Never
 * `toEqual` on a row: on failure vitest prints the whole object, and these rows
 * carry panel credentials.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { PROVIDER_COLUMNS, providerRow } from '../src/migrate.js';

type Row = Record<string, string | null>;

/** A JWT, whoever put it there. Catches the next credential column, not just
 *  the one we already know about. */
const JWT = /eyJ[A-Za-z0-9_-]{10,}\./;

/**
 * Read at module load, not in `beforeAll` — `describe.skipIf` is evaluated
 * during collection, which happens first.
 */
async function loadPanels(): Promise<{ rows: Row[]; unreachable: string | null }> {
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
      const [result] = await conn.query('SELECT * FROM marzban_panel');
      return { rows: result as Row[], unreachable: null };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[providers.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { rows: [], unreachable: why };
  }
}

const { rows, unreachable } = await loadPanels();

/** Index of a column in the tuple `providerRow` builds. */
function at(row: Row, column: (typeof PROVIDER_COLUMNS)[number]): unknown {
  return providerRow(row)[PROVIDER_COLUMNS.indexOf(column)];
}

function config(row: Row): Record<string, unknown> {
  return JSON.parse(at(row, 'config') as string) as Record<string, unknown>;
}

describe.skipIf(unreachable !== null)('the real marzban_panel rows, imported', () => {
  it('finds panels to check at all', () => {
    // Without this the whole file passes vacuously on an empty table.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('sends inbounds as a list of numbers, not as text that looks like one', () => {
    for (const row of rows) {
      const value = config(row)['inbounds'];
      if (value === undefined) continue; // a panel may genuinely have none
      expect(Array.isArray(value), `panel ${row['id']} inbounds is ${typeof value}`).toBe(true);
      for (const id of value as unknown[]) expect(typeof id).toBe('number');
    }
  });

  it('sends proxies as an object, not as text', () => {
    for (const row of rows) {
      const value = config(row)['proxies'];
      if (value === undefined) continue;
      expect(
        typeof value === 'object' && !Array.isArray(value),
        `panel ${row['id']} proxies is ${typeof value}`,
      ).toBe(true);
    }
  });

  it('carries no credential into a row the schema calls safe to dump', () => {
    for (const row of rows) {
      const keys = Object.keys(config(row));
      expect(JWT.test(JSON.stringify(config(row))), `panel ${row['id']} config has a JWT`).toBe(
        false,
      );
      expect(keys, `panel ${row['id']}`).not.toContain('datelogin');
      expect(keys, `panel ${row['id']}`).not.toContain('secret_code');
    }
  });

  it("names PasarGuard as PasarGuard, which is what version_panel '1' means", () => {
    // legacy/mirzabot-php/admin.php:749-750 stores the admin's `pasarguard`
    // choice as type='marzban' and records the truth in version_panel.
    const pasarguard = rows.filter((r) => r['version_panel'] === '1');
    expect(pasarguard.length, 'no version_panel=1 rows to check').toBeGreaterThan(0);
    for (const row of pasarguard) {
      expect(at(row, 'kind'), `panel ${row['id']}`).toBe('pasarguard');
    }
  });
});
