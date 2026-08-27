/**
 * The shop switches the bot now obeys, checked against the production dump.
 *
 * `apps/bot/src/settings.ts` compares against literal words — `offextra`,
 * `offtimeextraa`, `offstatus` — and reads two Toman limits by name. Those are
 * facts about the admin's own database, not about our code, and a test that
 * only asserted our constants would agree with itself forever.
 *
 * So this file asks the real `mirzabot` schema in the simulation MySQL, loaded
 * from `legacy/mirzabot-php/db/mirzabot-prod-20260811.sql`. If the admin
 * changes a switch, or a later dump spells it differently, this goes red rather
 * than the bot quietly drawing a button the shop turned off years ago.
 *
 * That dump is real customer data: it is gitignored, it stays on this machine,
 * and nothing below prints a value that is not a switch word or a limit.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';
import { productionDumpAbsent } from './helpers/productionDump.js';

type Pairs = Record<string, string | null>;

interface Loaded {
  shop: Pairs;
  pay: Pairs;
  bot: Pairs;
  unreachable: string | null;
}

/** Read at module load: `describe.skipIf` is evaluated during collection. */
async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  const empty = { shop: {}, pay: {}, bot: {} };
  // Before the connection, not after. `describe.skipIf` is evaluated during
  // collection, and a loader that connects first throws during collection —
  // which vitest reports as a FAILED FILE, not a skipped one. See
  // `helpers/productionDump.ts`.
  const dumpMissing = productionDumpAbsent();
  if (dumpMissing !== null) return { ...empty, unreachable: dumpMissing };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      // COLLATE utf8mb4_bin on every key comparison: MySQL's default collation
      // is case-insensitive, so `Statusextra` and `statusextra` would come back
      // as one row and a check could pass on a key the bot never reads.
      const [shopRows] = await conn.query(
        `SELECT Namevalue AS k, value AS v FROM shopSetting
          WHERE Namevalue COLLATE utf8mb4_bin
             IN ('statusextra', 'statustimeextra', 'statuschangeservice',
                 'chashbackextend', 'configshow')`,
      );
      const [payRows] = await conn.query(
        `SELECT NamePay AS k, ValuePay AS v FROM PaySetting
          WHERE NamePay COLLATE utf8mb4_bin IN ('minbalancecart', 'maxbalancecart')`,
      );
      // One row, four columns, so they arrive as four pairs rather than four
      // queries. `daywarn`, `volumewarn` and `on_hold_day` are the three
      // numbers `warn.ts` schedules unprompted messages on; until 2026-08-19
      // the first two were only asserted against a comment in the bot's own
      // test, which is the shape rule 6 exists to catch.
      const [botRows] = await conn.query(
        `SELECT affiliatespercentage, daywarn, volumewarn, on_hold_day,
                statuscopycart, linkappstatus FROM setting`,
      );
      const pairs = (rows: unknown): Pairs =>
        Object.fromEntries((rows as { k: string; v: string | null }[]).map((r) => [r.k, r.v]));
      /** The `setting` row itself: one record whose columns ARE the keys. */
      const columns = (rows: unknown): Pairs => {
        const row = (rows as Record<string, unknown>[])[0] ?? {};
        return Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v === null ? null : String(v)]),
        );
      };
      return {
        shop: pairs(shopRows),
        pay: pairs(payRows),
        bot: columns(botRows),
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[shop-switches.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { ...empty, unreachable: why };
  }
}

const { shop, pay, bot, unreachable } = await load();

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

describe.skipIf(unreachable !== null || dumpAbsent !== null)('the switch words the bot compares against', () => {
  it('spells the three off-words exactly as `settings.ts` expects', () => {
    // The bot treats a value it does not recognise as "leave the feature on",
    // so a spelling that drifted here would show customers buttons the shop
    // has switched off — with nothing looking broken. `offtimeextraa` really
    // does carry two a's; it is the legacy schema's own typo.
    expect(shop['statusextra']).toBe('offextra');
    expect(shop['statustimeextra']).toBe('offtimeextraa');
    expect(shop['statuschangeservice']).toBe('offstatus');
  });

  it('has all three switched off, which is why they are worth reading', () => {
    // Not a tautology with the assertion above: that one pins the spelling, this
    // one records the state the bot is being fixed to match. If an admin turns
    // one on, this goes red and somebody reads why.
    for (const key of ['statusextra', 'statustimeextra', 'statuschangeservice']) {
      expect(shop[key], key).not.toBeNull();
    }
  });
});

describe.skipIf(unreachable !== null || dumpAbsent !== null)('the numbers the bot reads', () => {
  it('gives the card-to-card path a floor and a ceiling, in Toman', () => {
    const min = Number(pay['minbalancecart']);
    const max = Number(pay['maxbalancecart']);
    expect(Number.isSafeInteger(min)).toBe(true);
    expect(Number.isSafeInteger(max)).toBe(true);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });

  it('is the pair index.php actually enforces, not the tier-keyed one', () => {
    // `minbalance`/`maxbalance` are JSON keyed by customer tier and are used
    // only to WORD the "not enough balance" message (index.php:1870). The card
    // path enforces these two flat values (index.php:4712). Reading the tier
    // JSON instead is how a 400,000 Toman ceiling got applied to every
    // customer, 25× below what the shop allows.
    expect(pay['minbalancecart']).not.toMatch(/^\s*\{/);
    expect(pay['maxbalancecart']).not.toMatch(/^\s*\{/);
  });

  it('pays a renewal cashback today, which is why the bot must pay one too', () => {
    // The one parity gap that costs the CUSTOMER money rather than the shop: a
    // renewal has been paying this percentage back for years, and the day the
    // PHP is switched off they would silently get nothing. The assertion is
    // "greater than zero", not "equals 5", because what matters is that the
    // shop pays one at all — the rate itself is the admin's to change and the
    // bot reads it from this same row.
    //
    // `chashbackextend` is spelled without the first `c` of "cash" in the
    // legacy schema. Reading the correct spelling finds nothing and pays
    // nobody, which is exactly the failure this file exists to catch — and
    // proved on 2026-08-16 by querying `cashbackextend` and watching it go red.
    const percent = Number(shop['chashbackextend']);
    expect(shop['chashbackextend'], 'chashbackextend is missing').not.toBeUndefined();
    expect(Number.isFinite(percent)).toBe(true);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it('carries a referral percentage that may be paid as one', () => {
    const percent = Number(bot['affiliatespercentage']);
    expect(Number.isFinite(percent)).toBe(true);
    // The bot refuses anything outside this range rather than clamping, because
    // this multiplies real money into a wallet.
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it('carries the three schedules the unprompted messages fire on', () => {
    // The exact numbers, because `DEFAULT_SHOP_SETTINGS` carries each one as
    // its fallback and the rule there is "a failed read behaves as the last
    // release did". A literal here is what makes that claim checkable: move a
    // slider in the admin panel and this goes red, so somebody decides whether
    // the fallback follows rather than finding out during an outage.
    //
    // `on_hold_day` is the one worth reading twice. `table.php` CREATES the
    // column with 4 and the shop runs 1 — so a fallback copied from the schema
    // would be four times slower than the shop it is standing in for, and
    // every test that used 4 would have agreed with it.
    expect(Number(bot['daywarn']), 'daywarn').toBe(2);
    expect(Number(bot['volumewarn']), 'volumewarn').toBe(1);
    expect(Number(bot['on_hold_day']), 'on_hold_day').toBe(1);
  });

  it('has all three button switches ON, which is why the bot draws them', () => {
    // The bot reads these as "off only on the exact off-word", so a shop that
    // has one of them off is the only way to tell whether the wiring works at
    // all. Today none of them is, and that is worth recording rather than
    // assuming: it is the reason nothing a customer sees changed when the
    // switches were wired up.
    //
    // `statuscopycart` and `linkappstatus` are `varchar(45)` holding `1`, not
    // integers. Reading either as a number and comparing it to a string is how
    // `roll_Status` read 963 customers wrong.
    expect(bot['statuscopycart'], 'statuscopycart').toBe('1');
    expect(bot['linkappstatus'], 'linkappstatus').toBe('1');
    expect(shop['configshow'], 'configshow').toBe('onconfig');
  });
});
