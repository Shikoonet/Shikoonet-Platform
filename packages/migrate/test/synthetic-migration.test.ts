/**
 * The migration tooling, against a synthetic MySQL that ships in the repo.
 *
 * ## Why this file is not one of the ten
 *
 * `packages/migrate/test/*.mysql.test.ts` skip at module load when the
 * production dump is absent, which in CI is always — the dump is real
 * customer money and Telegram ids and is git-ignored on purpose. Ten skipped
 * files under a heading called «migration gate» is not a gate.
 *
 * The obvious fix is to point those ten at a synthetic fixture, and it is the
 * wrong one. They assert things like `expect(expired.length).toBe(31)` and
 * «963 customers who never accepted the rules» — statements about the ACTUAL
 * dataset that is going to be migrated, which is the question they exist to
 * answer. Editing `31` to `2` would turn a data-migration acceptance check
 * into a test that asserts a fixture contains what the fixture contains.
 *
 * So there are two gates now, answering two questions:
 *
 *   this file        does the importer work?        CI, every pull request
 *   the ten          is THIS data safe to move?     Sam's machine, pre-cutover
 *
 * ## What runs here
 *
 * `preflight()` — the read-only half — against
 * `fixtures/synthetic-mirzabot.sql`, which carries one row for every value in
 * every closed set the transform declares, plus the eight edge cases that have
 * each cost a real afternoon. Nothing in it came from the production dump; see
 * that file's header.
 *
 * The money assertions are the point. The fixture's totals are written out in
 * its own header as Toman and as IRR, and asserted here — so a change to the
 * ×10 conversion, to the `CAST(price AS SIGNED)`, or to which statuses count
 * as paid fails in CI rather than on the night of the cutover.
 *
 * ## Skipping
 *
 * Guarded, like the ten, but on a variable the CI job sets rather than on a
 * file nobody has. `MIGRATE_FIXTURE_MYSQL=1` means «a MySQL loaded with the
 * synthetic fixture is reachable»; without it this skips locally, where most
 * people have no MySQL running. CI sets it, and `ci.yml` asserts afterwards
 * that these tests were not skipped — a required migration gate that silently
 * skips is the failure mode this whole file is about.
 */

import { createConnection, type Connection } from 'mysql2/promise';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { preflight } from '../src/preflight.js';
import { loadConfig } from '../src/db.js';
import * as t from '../src/transform.js';

/**
 * The switch. Set by the CI job that starts the MySQL service and loads the
 * fixture into it; absent on a laptop, where this skips rather than failing
 * for a reason that is not the developer's fault.
 */
const ENABLED = process.env['MIGRATE_FIXTURE_MYSQL'] === '1';

/**
 * The totals the fixture's own header writes out, in Toman.
 *
 * `paidPayments` and not the gross 2,410,000: preflight narrates the money
 * that actually ARRIVED, which is the figure the verify step has to match on
 * the other side. The gross total includes rows whose `payment_Status` is
 * `Unpaid`, `expire`, `reject`, `processing` and `waiting` — none of which is
 * money the shop holds.
 *
 * Getting this wrong in the test was instructive: the first version asserted
 * the gross figure and failed, which is the assertion doing its job. A test
 * that had asserted «some number appears» would have passed and said nothing.
 */
const EXPECTED_TOMAN = {
  walletBalances: 1_120_000,
  // FXORD0001 (195,000) + FXORD0007 (120,000), the two rows marked `paid`.
  paidPayments: 315_000,
};

let my: Connection | null = null;
let pgc: pg.Client | null = null;
let findings: Awaited<ReturnType<typeof preflight>> = [];
let output = '';

beforeAll(async () => {
  if (!ENABLED) return;
  const cfg = loadConfig();
  my = await createConnection({ ...cfg.mysql, charset: 'utf8mb4' });
  pgc = new pg.Client(cfg.postgres);
  await pgc.connect();

  // `preflight` narrates to stdout. Captured rather than silenced: several of
  // the assertions below are about what an operator is TOLD, and a check that
  // finds a problem and does not say so is the failure this project keeps
  // rediscovering.
  const written: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    written.push(args.map(String).join(' '));
  };
  try {
    findings = await preflight(cfg, my, pgc);
  } finally {
    console.log = realLog;
  }
  output = written.join('\n');
}, 120_000);

afterAll(async () => {
  await my?.end();
  await pgc?.end();
});

const maybe = ENABLED ? describe : describe.skip;

/**
 * A migration that actually INSERTS, because nothing here did.
 *
 * Issue #64: `migrateProducts` did not list `category_id`, which migration 0032
 * had made NOT NULL with no default, so every run died on the first product
 * with `23502`. It went unnoticed for weeks — the simulation database was
 * already seeded and nobody re-ran the import — and this file could not have
 * caught it, because it called `preflight` and `transform` and never wrote a
 * row to Postgres. A transform test proves the SHAPE of what would be written;
 * only an insert proves the database accepts it.
 *
 * `commit: false` is what makes this safe to run anywhere: `migrate` opens a
 * transaction and rolls it back, so the INSERTs are executed against the real
 * schema — constraints, defaults and all — and nothing survives the test.
 * `beforeSettle` is the only place the assertions can stand, because it runs
 * while the rows still exist; afterwards they are gone by design.
 */
maybe('a migration that reaches the database', () => {
  it('inserts the fixture products, every one of them filed under a category', async () => {
    const cfg = loadConfig();
    let seen: { products: number; orphans: number; categories: number } | null = null;

    /*
     * This fixture is deliberately unmigratable, and that is not a flaw in it.
     * It exists so `preflight` has every violation to find, and the duplicate
     * referral code is one of them — `users_referral_code_key` refuses it, as
     * it should. One file cannot be both «the database with every problem» and
     * «a database that migrates cleanly».
     *
     * So the test does what an operator does after reading the report: repairs
     * exactly the finding, runs the migration, and puts the source back. The
     * repair is in MySQL rather than in the fixture file, so the preflight
     * assertions above keep the row they are about.
     */
    await my!.query("UPDATE `user` SET codeInvitation = 'FIXREF05' WHERE id = 9000000000005");
    try {

      const result = await migrate(cfg, my!, pgc!, {
        commit: false,
        domains: ['catalog'],
        beforeSettle: async () => {
          const q = async (sql: string) => Number((await pgc!.query(sql)).rows[0]!['n']);
          seen = {
            products: await q('SELECT count(*)::int AS n FROM products'),
            orphans: await q('SELECT count(*)::int AS n FROM products WHERE category_id IS NULL'),
            categories: await q('SELECT count(*)::int AS n FROM product_categories'),
          };
          return true;
        },
      });

      expect(result.steps.some((step) => step.name.includes('products'))).toBe(true);
      // The fixture's own products, and the assertion that would have failed
      // with `23502` before the fix rather than passing quietly.
      expect(seen!.products).toBeGreaterThan(0);
      expect(seen!.orphans).toBe(0);
      expect(seen!.categories).toBeGreaterThan(0);
    } finally {
      await my!.query("UPDATE `user` SET codeInvitation = 'FIXREF01' WHERE id = 9000000000005");
    }
  }, 120_000);

  /**
   * The middle layer, and the reason issue #71 could not be answered from the
   * simulation.
   *
   * A legacy `product` row is one PRICE. On four real dumps every row shares a
   * single `inbounds`/`proxies` pair while a Location carries 1-7 of them, and
   * `migrateProducts` used to write each row as a service AND a plan — so the
   * shop's shape after migration would have been «one service per price»,
   * named «1ماهه-20گیگ-119.000ت», with one plan each. The sim answered «the
   * middle layer is unused» because the sim's shape was the importer's.
   *
   * What is asserted here is a SHAPE, not a number of rows this file happens to
   * contain, and the two properties that must not move are stated separately:
   *
   *   the safety property   every legacy row still becomes exactly one plan.
   *                         Read from MySQL, not written down — a hard-coded 7
   *                         would stop meaning «one per row» the moment
   *                         somebody adds a row to the fixture.
   *
   *   the shape             services are named by their Location and carry its
   *                         plans, which is only visible because the fixture
   *                         now holds Locations with two and three prices.
   */
  it('groups the legacy rows by Location, one service per Location', async () => {
    const cfg = loadConfig();
    interface Service {
      id: string;
      name: string;
      provider_name: string | null;
      once_per_user: boolean;
      resellers_only: boolean;
      plans: number;
    }
    let services: Service[] = [];
    let plans = 0;
    let planNames: string[] = [];
    let scopedCodes: { code: string; product_id: string }[] = [];

    // The source side, asked of MySQL.
    const [srcRows] = await my!.query<never>('SELECT COUNT(*) AS n FROM product');
    const legacyRows = Number((srcRows as unknown as { n: number }[])[0]!.n);
    // The fixture is not allowed to make this test vacuous: with one row per
    // Location the grouping would be indistinguishable from the old 1:1.
    expect(legacyRows).toBeGreaterThan(4);

    await my!.query("UPDATE `user` SET codeInvitation = 'FIXREF05' WHERE id = 9000000000005");
    let result;
    try {
      result = await migrate(cfg, my!, pgc!, {
        commit: false,
        domains: ['catalog', 'discounts'],
        beforeSettle: async () => {
          services = (
            await pgc!.query<Service>(
              `SELECT p.id, p.name, pr.name AS provider_name,
                      p.once_per_user, p.resellers_only,
                      (SELECT count(*)::int FROM product_plans pl
                        WHERE pl.product_id = p.id) AS plans
                 FROM products p
                 LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
                WHERE p.legacy_id IS NOT NULL`,
            )
          ).rows;
          plans = Number(
            (await pgc!.query('SELECT count(*)::int AS n FROM product_plans WHERE legacy_id IS NOT NULL'))
              .rows[0]!['n'],
          );
          planNames = (
            await pgc!.query<{ name: string }>(
              `SELECT pl.name FROM product_plans pl
                 JOIN products p ON p.id = pl.product_id
                WHERE p.name = '🥇 لوکیشن طلایی 🎯' ORDER BY pl.legacy_id`,
            )
          ).rows.map((r) => r.name);
          scopedCodes = (
            await pgc!.query<{ code: string; product_id: string }>(
              'SELECT code, product_id FROM discount_codes WHERE product_id IS NOT NULL',
            )
          ).rows;
          return true;
        },
      });
    } finally {
      await my!.query("UPDATE `user` SET codeInvitation = 'FIXREF01' WHERE id = 9000000000005");
    }

    // ── the safety property ────────────────────────────────────────────────
    // Nothing dropped, nothing merged away: one purchasable plan per legacy
    // row, and the same total as before the regrouping.
    expect(plans, 'every legacy product row must still be one plan').toBe(legacyRows);
    // …and the collapse actually happened. This is the assertion the old 1:1
    // mapping fails: it produced `plans` services.
    expect(services.length).toBeLessThan(plans);

    const byName = (name: string): Service[] => services.filter((s) => s.name === name);

    // ── the shape ─────────────────────────────────────────────────────────
    // Two prices on one Location: one service, two plans, and the service is
    // named after the Location rather than after either price.
    expect(byName('fixture panel A')).toHaveLength(1);
    expect(byName('fixture panel A')[0]!.plans).toBe(2);
    // Service and provider stay one-to-one: the Location IS the panel.
    expect(byName('fixture panel A')[0]!.provider_name).toBe('fixture panel A');

    // Persian with emoji at both ends, byte-for-byte through MySQL, Node and
    // Postgres — the Location's own name, three prices under it.
    expect(byName('🥇 لوکیشن طلایی 🎯')).toHaveLength(1);
    expect(byName('🥇 لوکیشن طلایی 🎯')[0]!.plans).toBe(3);
    // The prices stayed in the PLAN names, where legacy typed them.
    expect(planNames).toEqual([
      '1ماهه-20گیگ-119.000ت',
      '2ماهه-40گیگ-219.000ت',
      '3ماهه-60گیگ-299.000ت',
    ]);

    // ── the gates ─────────────────────────────────────────────────────────
    // `fixture panel B` holds a free trial beside a resellers-only tier.
    // `once_per_user` and `resellers_only` are columns of `products` and
    // `apps/bot/src/catalog.ts` asks both before selling any plan beneath, so
    // merging these two rows would either make the reseller price public or
    // make the free trial repeatable. They stay two services under one name.
    const panelB = byName('fixture panel B');
    expect(panelB).toHaveLength(2);
    expect(panelB.every((s) => s.plans === 1)).toBe(true);
    expect(panelB.filter((s) => s.once_per_user && !s.resellers_only)).toHaveLength(1);
    expect(panelB.filter((s) => s.resellers_only && !s.once_per_user)).toHaveLength(1);

    // ── the discounts ─────────────────────────────────────────────────────
    // Money points at the plan (`orders.plan_id`); a discount points at the
    // service (`discount_codes.product_id`). `DiscountSell.code_product` names
    // a legacy ROW, so a code scoped to a row that is no longer a service of
    // its own has to resolve THROUGH its plan to the service carrying it.
    const scoped = new Map(scopedCodes.map((c) => [c.code, c.product_id]));
    // fxp01 heads its group, fxp02 does not. Both are `fixture panel A`.
    expect(scoped.get('FXSELL30')).toBe(byName('fixture panel A')[0]!.id);
    expect(scoped.get('FXSELL40')).toBe(byName('fixture panel A')[0]!.id);
    // fxp07 is the THIRD row of its Location — the case a lookup on
    // `products.code` alone drops entirely.
    expect(scoped.get('FXSELL50')).toBe(byName('🥇 لوکیشن طلایی 🎯')[0]!.id);
    // …and none of them was quietly thrown away on the way.
    expect(
      result.skipped.filter(([what]) => what.includes('scoped to a product that is gone')),
    ).toEqual([]);
  }, 120_000);
});

/**
 * The report is stored and rendered now, so it may not carry a card number.
 *
 * `preflight` was written for a terminal. Since PR #42 the panel runs the
 * import: `importRoutes.ts` writes the captured report into
 * `import_runs.report` and `ImportPage.tsx` paints it. On 2026-09-02 a real
 * backup run through the panel put 34 full customer PANs into Postgres and
 * onto a screen (issue #52).
 *
 * Asserted against the OUTPUT rather than against `maskPan`, because the bug
 * was never in the masking — there was none — it was in what the report chose
 * to interpolate. A test of the helper would have passed on the broken code.
 */
maybe('what the card section is allowed to say', () => {
  it('never prints a whole card number', () => {
    // The fixture holds `0000000000000000`, `0000000000000018` and a
    // Luhn-invalid `0000000000000001`, so a regression has something to leak.
    const runs = output.match(/\b\d{12,19}\b/g) ?? [];
    expect(runs, `the report printed ${runs.join(', ')}`).toEqual([]);
  });

  it('still says enough to act on', () => {
    // Masked, not removed. The first six name the issuing bank and the last
    // four are what an operator matches against the source row — an operator
    // told only «one card failed» cannot find it.
    expect(output).toContain('000000\u2022\u2022\u2022\u2022\u2022\u20220001');
  });
});

maybe('preflight, against the synthetic fixture', () => {
  it('runs to completion and returns findings', () => {
    // The floor. A preflight that threw would fail `beforeAll`, but one that
    // returned nothing at all would pass every `some()` assertion below
    // vacuously — so the count is asserted first.
    expect(findings.length).toBeGreaterThan(0);
    expect(output.length).toBeGreaterThan(0);
  });

  it('reads every table in the source inventory', () => {
    // The tables preflight counts, each of which the fixture fills. A table
    // that vanished from the fixture — or from the inventory — shows up here
    // as a count that never appeared.
    for (const table of [
      'user',
      'invoice',
      'Payment_report',
      'service_other',
      'product',
      'marzban_panel',
      'card_number',
      'card_assignment_leases',
      'Discount',
      'DiscountSell',
      'Giftcodeconsumed',
      'reagent_report',
      'Requestagent',
      'revenue_adjustment_log',
    ]) {
      expect(output, `no count reported for ${table}`).toContain(`mysql.${table}`);
    }
  });

  it('maps every value in every closed set — no BLOCKER about an enum', () => {
    // The fixture carries one row for every key of PAYMENT_STATUS,
    // PAYMENT_METHOD, SUBSCRIPTION_STATUS, ORDER_KIND, LEASE_STATUS,
    // PANEL_TYPE and PANEL_VERSION. If the transform loses an entry — or the
    // fixture gains a value the transform does not know — preflight raises a
    // BLOCKER naming the column, and this is where it is seen.
    // Named columns, not a keyword search. The first version matched any
    // BLOCKER whose text contained «value» and caught the duplicate-referral
    // finding, which is a different problem the fixture raises ON PURPOSE.
    const ENUM_COLUMNS = [
      'Payment_report.payment_Status',
      'Payment_report.Payment_Method',
      'invoice.Status',
      'service_other.type',
      'card_assignment_leases.status',
      'marzban_panel.type',
      'marzban_panel.version_panel',
    ];
    const enumBlockers = findings.filter(
      (f) => f.level === 'BLOCKER' && ENUM_COLUMNS.some((c) => (f.check + f.detail).includes(c)),
    );
    expect(
      enumBlockers.map((f) => `${f.check}: ${f.detail}`),
      'an enum value in the fixture is not in the transform map',
    ).toEqual([]);

    // And the positive half: preflight must SAY each column mapped. A run
    // that skipped the enum section entirely would satisfy the assertion
    // above by finding nothing.
    for (const column of ENUM_COLUMNS) {
      expect(output, `preflight never reported on ${column}`).toContain(column);
    }
  });

  it('finds the duplicate referral code', () => {
    // Two `user` rows share `FIXREF01`, and `users.referral_code` is UNIQUE in
    // the target. Preflight has to refuse before the migration hits the
    // constraint half-way through.
    const dup = findings.filter((f) => /codeInvitation|referral/i.test(f.check + f.detail));
    expect(dup.length, `expected a duplicate-referral finding, got: ${JSON.stringify(findings.map((f) => f.check))}`).toBeGreaterThan(0);
    expect(dup.some((f) => f.level === 'BLOCKER')).toBe(true);
  });

  it('finds the Luhn-invalid card and does not wave it through', () => {
    // `0000000000000001` fails the checksum. A card that cannot be a card is
    // either a typo with a known correction or a BLOCKER; silence is neither.
    const card = findings.filter((f) => /card/i.test(f.check));
    expect(card.length).toBeGreaterThan(0);
    // Masked, since this commit. The assertion still has to name a specific
    // card rather than settle for «some card failed» — that is the whole
    // point of the check — but the first six and last four are enough to
    // find the source row, and they are all an operator is owed.
    expect(output).toContain('000000\u2022\u2022\u2022\u2022\u2022\u20220001');
  });

  it('finds the orphan payment and keeps its money in the total', () => {
    // `Payment_report` row 7 names a user that does not exist. It is a NOTICE,
    // not a BLOCKER: the row carries money, and dropping it would move the
    // total — which is the one thing the verify step must never see happen.
    const orphan = findings.filter((f) => /orphan/i.test(f.check));
    expect(orphan.length).toBeGreaterThan(0);
    expect(orphan.every((f) => f.level === 'NOTICE')).toBe(true);
  });

  it('reports the gift codes that credit nothing', () => {
    // Three rows: NULL, '' and '0'. Each is a code a customer could redeem
    // for zero, and each is worth an operator's attention before the import.
    expect(output).toContain('FXGIFTNUL');
    expect(output).toContain('FXGIFTEMP');
    expect(output).toContain('FXGIFTZER');
  });

  it('carries the negative balance rather than cleaning it', () => {
    // `schema-design.md:64` — production holds a real negative balance and the
    // migration reproduces reality. A preflight that silently zeroed it would
    // make the verify step's «zero Rial difference» a lie.
    expect(output).toContain('fixture-gamma');
    const negatives = findings.filter((f) => /negative/i.test(f.check + f.detail));
    expect(negatives.length).toBeGreaterThan(0);
  });
});

maybe('the money, to the Rial', () => {
  /** Every digit group in the narration, as numbers. */
  function numbersIn(text: string): number[] {
    return [...text.matchAll(/[\d,]{4,}/g)]
      .map((m) => Number(m[0].replace(/,/g, '')))
      .filter((n) => Number.isFinite(n));
  }

  it('totals the wallet balances in Toman and in IRR', () => {
    // Both units, because the ×10 is the single most consequential line in the
    // whole migration: Mirzabot stores Toman, the new schema stores IRR, and
    // an off-by-ten is a shop that is wrong by 900%.
    const seen = numbersIn(output);
    expect(seen, 'wallet total in Toman').toContain(EXPECTED_TOMAN.walletBalances);
    expect(seen, 'wallet total in IRR').toContain(EXPECTED_TOMAN.walletBalances * 10);
  });

  it('totals the PAID payments in Toman and in IRR', () => {
    const seen = numbersIn(output);
    expect(seen, 'paid total in Toman').toContain(EXPECTED_TOMAN.paidPayments);
    expect(seen, 'paid total in IRR').toContain(EXPECTED_TOMAN.paidPayments * 10);
  });

  it('counts only the rows that are actually paid', () => {
    // The boundary, stated as its own test. Five of the seven payment rows
    // carry a status that is not `paid`, and their 2,095,000 Toman must NOT
    // be in the total — a preflight that summed every row would report money
    // the shop does not have and the verify step would then «agree».
    const seen = numbersIn(output);
    expect(seen, 'the gross total must not be reported as paid').not.toContain(2_410_000);
  });

  it('the IRR total is exactly ten times the Toman total, with no rounding', () => {
    // Asserted on the conversion itself as well as on the narration, because
    // the narration could be right while the function that writes the rows is
    // not. `toIrr` is what `migrate.ts` calls per row.
    for (const toman of [EXPECTED_TOMAN.walletBalances, EXPECTED_TOMAN.paidPayments, -940_000, 0]) {
      expect(t.tomanToIrr(String(toman))).toBe(BigInt(toman) * 10n);
    }
  });
});

maybe('the closed sets, exercised by the fixture', () => {
  it('every documented status maps, and an undocumented one throws', () => {
    // The fixture contains one row per key; this asserts the map directly, so
    // a key removed from the transform is named here even if no fixture row
    // happened to reach it.
    for (const [legacy, expected] of Object.entries(t.PAYMENT_STATUS)) {
      expect(t.paymentStatus(legacy)).toBe(expected);
    }
    for (const [legacy, expected] of Object.entries(t.SUBSCRIPTION_STATUS)) {
      expect(t.subscriptionStatus(legacy)).toBe(expected);
    }
    // The refusal. A value nobody declared must stop the migration and name
    // itself, rather than become a status that means something else.
    expect(() => t.paymentStatus('not-a-real-status')).toThrow();
  });

  it('both spellings of disabled land on DISABLED', () => {
    // Not a typo on our side: production contains `disabled` and `disabledn`,
    // from a bug in the PHP that writes the column. The fixture has both.
    expect(t.subscriptionStatus('disabled')).toBe('DISABLED');
    expect(t.subscriptionStatus('disabledn')).toBe('DISABLED');
    expect(t.subscriptionStatus('disablebyadmin')).toBe('DISABLED');
  });

  it('the tinyint(1) flags read as numbers, not strings', () => {
    // The 963-customer bug, pinned. mysql2 returns `tinyint(1)` as a NUMBER;
    // `migrate.ts` once compared it with the string `'0'`, and `0 !== '0'` is
    // true, so every customer who had not accepted the rules migrated in as
    // having accepted them.
    expect(t.legacyBool(0, 'user.roll_Status')).toBe(false);
    expect(t.legacyBool(1, 'user.roll_Status')).toBe(true);
    expect(0 !== ('0' as unknown)).toBe(true);
  });
});