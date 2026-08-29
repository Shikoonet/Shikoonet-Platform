/**
 * Post-migration verification.
 *
 * The rule this file exists to enforce: **one Rial of difference stops the
 * migration from being accepted.** Not "close enough", not "within rounding" —
 * money is integer IRR on both sides and the totals either match exactly or the
 * migration is wrong.
 *
 * Row counts are checked too, but they are the weaker test. A migration can
 * move every row and still corrupt every amount.
 */

import type { Connection } from 'mysql2/promise';
import type pg from 'pg';
import { fmt, mysqlRows, report, type Config } from './db.js';
import { DOMAINS, type Domain } from './migrate.js';

export interface Check {
  name: string;
  source: bigint;
  target: bigint;
  /** Rows legitimately not migrated, with the reason. */
  allowance?: { rows: bigint; reason: string };
}

function delta(c: Check): bigint {
  return c.target - c.source + (c.allowance?.rows ?? 0n);
}

async function scalar(my: Connection, sql: string): Promise<bigint> {
  const [row] = await mysqlRows<Record<string, string | number | null>>(my, sql);
  const v = row ? Object.values(row)[0] : 0;
  return BigInt(v ?? 0);
}

async function pgScalar(client: pg.Client, sql: string): Promise<bigint> {
  const { rows } = await client.query<Record<string, string | null>>(sql);
  const v = rows[0] ? Object.values(rows[0])[0] : '0';
  return BigInt(v ?? 0);
}

/**
 * Verifies only the domains that were actually imported.
 *
 * A check for a domain nobody asked for is not a passing check, it is a
 * failing one: `wheel_list` holds 1,677 rows and `wheel_spins` would hold
 * none. Scoping is what keeps "we did not import this" from reading as "the
 * money is wrong".
 */
export async function verify(
  _cfg: Config,
  my: Connection,
  pgc: pg.Client,
  domains: Iterable<Domain> = DOMAINS,
): Promise<boolean> {
  const money: Check[] = [];
  const counts: Check[] = [];
  const selected = new Set<Domain>([...domains, 'core']);
  const want = (d: Domain): boolean => selected.has(d);
  report.step(`verifying domains: ${[...selected].join(', ')}`);

  // =========================================================================
  report.title('money — exact equality required');
  // =========================================================================

  if (want('core')) money.push({
    name: 'wallet balances (IRR)',
    source: (await scalar(my, 'SELECT SUM(Balance) FROM `user`')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(balance_irr),0) FROM wallets'),
  });

  // The ledger must reproduce the balance it derived, or the trigger is wrong.
  if (want('core')) money.push({
    name: 'wallet ledger sum (IRR)',
    source: (await scalar(my, 'SELECT SUM(Balance) FROM `user`')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(amount_irr),0) FROM wallet_entries'),
  });

  if (want('sales')) money.push({
    name: 'all payments (IRR)',
    source: (await scalar(my, 'SELECT SUM(CAST(price AS SIGNED)) FROM Payment_report')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(amount_irr),0) FROM payments'),
  });

  if (want('sales')) money.push({
    name: 'settled payments (IRR)',
    source:
      (await scalar(
        my,
        "SELECT SUM(CAST(price AS SIGNED)) FROM Payment_report WHERE payment_Status='paid'",
      )) * 10n,
    target: await pgScalar(
      pgc,
      "SELECT COALESCE(SUM(amount_irr),0) FROM payments WHERE status='PAID'",
    ),
  });

  if (want('sales')) money.push({
    name: 'subscription value (IRR)',
    source: (await scalar(my, 'SELECT SUM(CAST(price_product AS SIGNED)) FROM invoice')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(price_irr),0) FROM subscriptions'),
  });

  if (want('history')) money.push({
    name: 'wheel prizes (IRR)',
    source: (await scalar(my, 'SELECT SUM(CAST(price AS SIGNED)) FROM wheel_list')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(amount_irr),0) FROM wheel_spins'),
    allowance: {
      rows:
        (await scalar(
          my,
          `SELECT COALESCE(SUM(CAST(w.price AS SIGNED)),0) FROM wheel_list w
           LEFT JOIN user u ON u.id = w.id_user WHERE u.id IS NULL`,
        )) * 10n,
      reason: 'prizes belonging to deleted users',
    },
  });

  // The admin's own running total is the source, not the log's sum, and the
  // difference is the point: `setting.revenue_adjustment` is the number the
  // legacy panel PRINTS, arrived at independently of how we read the rows. A
  // sign flipped on import shows up here and nowhere else — the row count stays
  // identical, every other total stays identical, and the books move by twice
  // the deductions. That is the exact failure the importer's dead `subtract`
  // branch was one keystroke away from causing.
  if (want('config')) money.push({
    name: 'revenue adjustments (IRR)',
    source: (await scalar(my, 'SELECT revenue_adjustment FROM setting LIMIT 1')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(amount_irr),0) FROM revenue_adjustments'),
  });

  if (want('sales')) money.push({
    name: 'add-on orders (IRR)',
    source: (await scalar(my, 'SELECT SUM(CAST(price AS SIGNED)) FROM service_other')) * 10n,
    target: await pgScalar(pgc, 'SELECT COALESCE(SUM(total_irr),0) FROM orders'),
    allowance: {
      rows:
        (await scalar(
          my,
          `SELECT COALESCE(SUM(CAST(s.price AS SIGNED)),0) FROM service_other s
           LEFT JOIN user u ON u.id = s.id_user WHERE u.id IS NULL`,
        )) * 10n,
      reason: 'orders belonging to deleted users',
    },
  });

  let allExact = true;
  for (const c of money) {
    const d = delta(c);
    const label = `${c.name.padEnd(26)} ${fmt(c.source).padStart(17)} -> ${fmt(c.target).padStart(17)}`;
    if (d === 0n) {
      report.ok(label);
      if (c.allowance && c.allowance.rows !== 0n) {
        report.detail(`+ ${fmt(c.allowance.rows)} IRR ${c.allowance.reason}`);
      }
    } else {
      allExact = false;
      report.fail(`${label}   off by ${fmt(d)} IRR`);
    }
  }

  // =========================================================================
  report.title('row counts');
  // =========================================================================

  // [domain, label, source count, target count, allowance count?, allowance reason?]
  const pairs: [Domain, string, string, string, string?, string?][] = [
    ['core', 'users', 'SELECT COUNT(*) FROM `user`', 'SELECT COUNT(*) FROM users'],
    ['core', 'wallets', 'SELECT COUNT(*) FROM `user`', 'SELECT COUNT(*) FROM wallets'],
    ['sales', 'subscriptions', 'SELECT COUNT(*) FROM invoice', 'SELECT COUNT(*) FROM subscriptions'],
    ['sales', 'payments', 'SELECT COUNT(*) FROM Payment_report', 'SELECT COUNT(*) FROM payments'],
    [
      'config',
      'card leases',
      'SELECT COUNT(*) FROM card_assignment_leases',
      'SELECT COUNT(*) FROM card_leases',
    ],
    // Scoped to migrated rows. The catalog is the one area where a developer
    // legitimately seeds fixture rows into the same tables (packages/seed's
    // seedCatalog, so the bot has something to sell offline), and a bare
    // COUNT(*) then reports a migration failure that is really six fixture
    // products. `legacy_id` is exactly "this row came from MySQL".
    [
      'catalog',
      'products',
      'SELECT COUNT(*) FROM product',
      'SELECT COUNT(*) FROM products WHERE legacy_id IS NOT NULL',
    ],
    [
      'catalog',
      'product plans',
      'SELECT COUNT(*) FROM product',
      'SELECT COUNT(*) FROM product_plans WHERE legacy_id IS NOT NULL',
    ],
    [
      'catalog',
      'providers',
      'SELECT COUNT(*) FROM marzban_panel',
      'SELECT COUNT(*) FROM provisioning_providers WHERE legacy_id IS NOT NULL',
    ],
    // Neither legacy table has a unique code, so 18 rows are duplicates that
    // collapse into their winning code. The allowance is computed, not assumed.
    [
      'discounts',
      'discount codes',
      'SELECT (SELECT COUNT(*) FROM Discount)+(SELECT COUNT(*) FROM DiscountSell)',
      'SELECT COUNT(*) FROM discount_codes',
      `SELECT (SELECT COUNT(*) FROM Discount) + (SELECT COUNT(*) FROM DiscountSell)
             - (SELECT COUNT(*) FROM (
                 SELECT code COLLATE utf8mb4_bin AS c FROM Discount WHERE code IS NOT NULL
                  UNION
                 SELECT codeDiscount COLLATE utf8mb4_bin FROM DiscountSell
                  WHERE codeDiscount IS NOT NULL) u)`,
    ],
    [
      'discounts',
      'redemptions',
      'SELECT COUNT(*) FROM Giftcodeconsumed',
      'SELECT COUNT(*) FROM discount_redemptions',
    ],
    [
      'config',
      'revenue adjustments',
      'SELECT COUNT(*) FROM revenue_adjustment_log',
      'SELECT COUNT(*) FROM revenue_adjustments',
    ],
    [
      'history',
      'support tickets',
      'SELECT COUNT(*) FROM support_message',
      'SELECT COUNT(*) FROM support_tickets',
    ],
    [
      'history',
      'wheel spins',
      'SELECT COUNT(*) FROM wheel_list',
      'SELECT COUNT(*) FROM wheel_spins',
      `SELECT COUNT(*) FROM wheel_list w LEFT JOIN user u ON u.id=w.id_user WHERE u.id IS NULL`,
    ],
    [
      'config',
      'reseller requests',
      'SELECT COUNT(*) FROM Requestagent',
      'SELECT COUNT(*) FROM reseller_requests',
      `SELECT COUNT(*) FROM Requestagent r LEFT JOIN user u ON u.id=r.id WHERE u.id IS NULL`,
    ],
    [
      'sales',
      'add-on orders',
      'SELECT COUNT(*) FROM service_other',
      'SELECT COUNT(*) FROM orders',
      `SELECT COUNT(*) FROM service_other s LEFT JOIN user u ON u.id=s.id_user WHERE u.id IS NULL`,
    ],
    // The two legacy `tinyint(1)` flags, counted on both sides.
    //
    // These are here because of what happened without them. `migrate.ts` read
    // `r.roll_Status !== '0'` — a number compared against a string, true for
    // every row — and all 963 customers who never accepted the shop's rules
    // arrived as having accepted them. Row counts matched, every money total
    // matched, and the only thing that changed was which side of a gate 963
    // people stood on. Nothing in this file looked at it.
    //
    // A count on each side is the cheapest thing that would have failed: 963
    // against 0 is not a rounding difference. Any future flag of this shape gets
    // a line here rather than trust.
    [
      'core',
      'customers who have not accepted the rules',
      'SELECT COUNT(*) FROM `user` WHERE roll_Status = 0',
      'SELECT COUNT(*) FROM users WHERE rules_accepted = false',
    ],
    [
      'core',
      'referral bonuses already claimed',
      'SELECT COUNT(*) FROM reagent_report WHERE get_gift = 1',
      'SELECT COUNT(*) FROM users WHERE referral_bonus_claimed = true',
      // A claimed bonus whose referrer or referred customer is gone never
      // reaches a row to set the flag on, exactly like the wheel spins above.
      `SELECT COUNT(*) FROM reagent_report r
         LEFT JOIN user c ON c.id = r.user_id
         LEFT JOIN user p ON p.id = r.reagent
        WHERE r.get_gift = 1 AND (c.id IS NULL OR p.id IS NULL)`,
    ],
  ];

  for (const [domain, name, srcSql, tgtSql, allowSql, allowReason] of pairs) {
    if (!want(domain)) continue;
    const check: Check = {
      name,
      source: await scalar(my, srcSql),
      target: await pgScalar(pgc, tgtSql),
      ...(allowSql
        ? {
            allowance: {
              rows: await scalar(my, allowSql),
              reason: allowReason ?? 'rows belonging to deleted users',
            },
          }
        : {}),
    };
    counts.push(check);
    const d = delta(check);
    const label =
      `${name.padEnd(22)} ${String(check.source).padStart(7)} -> ` +
      `${String(check.target).padStart(7)}`;
    if (d === 0n) {
      report.ok(
        check.allowance && check.allowance.rows > 0n
          ? `${label}  (+${check.allowance.rows} skipped: ${check.allowance.reason})`
          : label,
      );
    } else {
      allExact = false;
      report.fail(`${label}   off by ${d}`);
    }
  }

  // =========================================================================
  report.title('payment hub (D1)');
  // =========================================================================
  for (const table of want('hub') ? [
    'devices',
    'financial_accounts',
    'raw_sms_events',
    'transaction_candidates',
    'payment_claims',
    'reconciliation_matches',
    'payment_cards',
    'audit_logs',
  ] : []) {
    const n = await pgScalar(pgc, `SELECT COUNT(*) FROM ${table}`);
    report.count(table, n.toString());
  }

  // =========================================================================
  report.title('invariants after migration');
  // =========================================================================
  const drift = await pgScalar(
    pgc,
    `
    SELECT COUNT(*) FROM wallets w
      LEFT JOIN (SELECT user_id, SUM(amount_irr) s FROM wallet_entries GROUP BY 1) e
             ON e.user_id = w.user_id
     WHERE w.balance_irr <> COALESCE(e.s, 0)`,
  );
  if (drift === 0n) {
    report.ok('every wallet balance equals the sum of its entries');
  } else {
    allExact = false;
    report.fail(`${drift} wallet(s) disagree with their ledger`);
  }

  const doubleSettled = await pgScalar(
    pgc,
    `
    SELECT COUNT(*) FROM (
      SELECT transaction_candidate_id FROM reconciliation_matches
       WHERE status IN ('CONFIRMED','AUTO_VERIFIED')
       GROUP BY 1 HAVING COUNT(*) > 1) x`,
  );
  if (doubleSettled === 0n) {
    report.ok('no bank transaction settles more than one claim');
  } else {
    allExact = false;
    report.fail(`${doubleSettled} transaction(s) settle multiple claims`);
  }

  const badCards = await pgScalar(
    pgc,
    `
    SELECT COUNT(*) FROM payment_cards
     WHERE card_digits !~ '^[0-9]{12,19}$'`,
  );
  if (badCards === 0n) {
    report.ok('every migrated card number is well formed');
  } else {
    allExact = false;
    report.fail(`${badCards} card number(s) are malformed`);
  }

  const futureRows = await pgScalar(
    pgc,
    `
    SELECT (SELECT COUNT(*) FROM payments WHERE created_at > now() + interval '1 day')
         + (SELECT COUNT(*) FROM subscriptions WHERE purchased_at > now() + interval '1 day')
         + (SELECT COUNT(*) FROM users WHERE registered_at < timestamptz '2015-01-01')`,
  );
  if (futureRows === 0n) {
    report.ok('no timestamp landed outside a plausible range');
  } else {
    allExact = false;
    report.fail(
      `${futureRows} row(s) have an implausible timestamp — check the timezone conversion`,
    );
  }

  // Two things that were both true at once and neither of which any count could
  // see: JSON columns arriving as text (`"[42,2]"` instead of `[42,2]`, which
  // the panel answers 422 to), and a live admin JWT riding along in `config`.
  // Checked on the target side because that is where the damage would be.
  const badConfig = await pgScalar(
    pgc,
    `
    SELECT COUNT(*) FROM provisioning_providers p, jsonb_each(p.config) AS kv(k, v)
     WHERE jsonb_typeof(kv.v) = 'string'
       AND ((kv.v #>> '{}') ~ '^\\s*[\\[{]' OR (kv.v #>> '{}') ~ 'eyJ[A-Za-z0-9_-]{10,}\\.')`,
  );
  if (badConfig === 0n) {
    report.ok('no provider config holds JSON-as-text or a credential');
  } else {
    allExact = false;
    report.fail(`${badConfig} provider config value(s) are unparsed JSON or look like a token`);
  }

  report.title(allExact ? 'verified' : 'VERIFICATION FAILED');
  console.log(
    allExact
      ? '\n  Every money total matches to the Rial.\n'
      : '\n  Do not accept this migration. Investigate the failures above.\n',
  );
  return allExact;
}
