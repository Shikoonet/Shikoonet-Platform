/**
 * The panel's money ceiling, judged against the shop rather than against itself.
 *
 * Three routes bound a hand-typed amount — a plan's price, a gift code's value,
 * a wallet correction — and until this file the only test of any of them said
 * `expect(create({ amountIrr: CODE_MAX_IRR })).toBe(201)` and
 * `CODE_MAX_IRR + 1` to be 400. That is true for *every* number. Move the
 * constant to 10^12 and both assertions still pass while the guard stops
 * catching the failure it exists for: a typed extra zero.
 *
 * So the ceiling is checked here, against two facts about the admin's own
 * database that our code has no say in:
 *
 *   `PaySetting.maxbalancecart` — the most a single card-to-card transfer may
 *   settle. A price above it cannot be paid in one payment, which is the whole
 *   argument for the number being what it is.
 *
 *   `MAX(product.price_product)` — the priciest thing this shop has ever sold.
 *   The ceiling should sit comfortably above it and nowhere near a typo.
 *
 * That dump is real customer data: it is gitignored, it stays on this machine,
 * and nothing below prints a value from it.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';
import { loadConfig } from '../src/db.js';
import { productionDumpAbsent } from './helpers/productionDump.js';

interface Loaded {
  /** `PaySetting.maxbalancecart`, in Toman. */
  cardCeilingToman: number | null;
  /** `MAX(product.price_product)`, in Toman. */
  priciestSaleToman: number | null;
  /** How many product rows that maximum was taken over. */
  productRows: number;
  unreachable: string | null;
}

/** Read at module load: `describe.skipIf` is evaluated during collection. */
async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  // Before the connection, not after. `describe.skipIf` is evaluated during
  // collection, and a loader that connects first throws during collection —
  // which vitest reports as a FAILED FILE, not a skipped one. See
  // `helpers/productionDump.ts`.
  const dumpMissing = productionDumpAbsent();
  if (dumpMissing !== null) return { ...{ cardCeilingToman: null, priciestSaleToman: null, productRows: 0 }, unreachable: dumpMissing };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      // COLLATE utf8mb4_bin on the key: MySQL's default collation is
      // case-insensitive, so `MaxBalanceCart` and `maxbalancecart` would come
      // back as one row and this could pass on a key nothing reads.
      const [pay] = await conn.query(
        `SELECT ValuePay AS v FROM PaySetting
          WHERE NamePay COLLATE utf8mb4_bin = 'maxbalancecart'`,
      );
      const [prices] = await conn.query(
        `SELECT MAX(CAST(price_product AS UNSIGNED)) AS top, COUNT(*) AS n FROM product`,
      );
      const payRows = pay as { v: string | null }[];
      const priceRows = prices as { top: string | null; n: string | number }[];
      return {
        cardCeilingToman: payRows[0]?.v === undefined ? null : Number(payRows[0].v),
        priciestSaleToman: priceRows[0]?.top == null ? null : Number(priceRows[0].top),
        productRows: Number(priceRows[0]?.n ?? 0),
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[catalog-ceiling.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { cardCeilingToman: null, priciestSaleToman: null, productRows: 0, unreachable: why };
  }
}

const { cardCeilingToman, priciestSaleToman, productRows, unreachable } = await load();

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

describe.skipIf(unreachable !== null || dumpAbsent !== null)('the ceiling every typed amount is checked against', () => {
  it('is exactly the largest single payment the shop accepts', () => {
    // The one relationship the source comments claim and nothing verified:
    // 100,000,000 IRR is `maxbalancecart` in Toman, times ten. If the admin
    // raises or lowers their card limit, this goes red and somebody decides
    // deliberately — rather than the panel silently accepting a price no
    // customer can pay in one transfer.
    expect(cardCeilingToman).not.toBeNull();
    expect(MAX_SINGLE_PAYMENT_IRR).toBe(cardCeilingToman! * 10);
  });

  it('sits above the priciest thing this shop has ever sold', () => {
    // A ceiling below a real product would refuse an admin re-typing a price
    // they already charge.
    expect(productRows).toBeGreaterThan(0);
    expect(priciestSaleToman).not.toBeNull();
    expect(MAX_SINGLE_PAYMENT_IRR).toBeGreaterThan(priciestSaleToman! * 10);
  });

  it('is close enough to the real catalogue to still catch an extra zero', () => {
    // This is the assertion `discounts.test.ts` could not make. A ceiling
    // raised until it stops rejecting anything is not a guard, and 10× a real
    // price is one typed zero — so a ceiling more than about 20× the priciest
    // real sale has stopped doing its job.
    const ratio = MAX_SINGLE_PAYMENT_IRR / (priciestSaleToman! * 10);
    expect(ratio).toBeLessThanOrEqual(20);
  });
});
