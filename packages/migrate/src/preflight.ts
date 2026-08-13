/**
 * Pre-flight: everything worth knowing BEFORE a single row is written.
 *
 * A migration that discovers a problem halfway through has already made a mess.
 * This command writes nothing. It reads both sources, checks every assumption
 * the migration depends on, and returns a verdict.
 *
 * BLOCKER  the migration would produce wrong data — it refuses to run.
 * NOTICE   a real-world irregularity that is carried over deliberately.
 */

import type { Connection } from 'mysql2/promise';
import type pg from 'pg';
import { cardCorrectionFor, correctCardDigits } from './corrections.js';
import { d1Table, fmt, mysqlRows, report, type Config } from './db.js';
import * as t from './transform.js';

export interface Finding {
  level: 'BLOCKER' | 'NOTICE';
  check: string;
  detail: string;
}

/** Every legacy column whose values must land in a closed set. */
const ENUM_CHECKS = [
  { table: 'Payment_report', column: 'payment_Status', map: t.PAYMENT_STATUS },
  { table: 'Payment_report', column: 'Payment_Method', map: t.PAYMENT_METHOD },
  { table: 'invoice', column: 'Status', map: t.SUBSCRIPTION_STATUS },
  { table: 'service_other', column: 'type', map: t.ORDER_KIND },
  { table: 'card_assignment_leases', column: 'status', map: t.LEASE_STATUS },
  // Which panel software each provider is. A sixth panel of a type we cannot
  // store, or one with no `version_panel`, has to stop the migration and name
  // itself — not quietly become a `kind` that speaks a different protocol.
  { table: 'marzban_panel', column: 'type', map: t.PANEL_TYPE },
  { table: 'marzban_panel', column: 'version_panel', map: t.PANEL_VERSION },
] as const;

export async function preflight(cfg: Config, my: Connection, pgc: pg.Client): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], check: string, detail: string) =>
    findings.push({ level, check, detail });

  // -------------------------------------------------------------------------
  report.title('source inventory');
  // -------------------------------------------------------------------------
  const counts = new Map<string, number>();
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
    'wheel_list',
    'support_message',
    'departman',
    'help',
    'app',
    'channels',
    'admin',
    'setting',
    'shopSetting',
    'PaySetting',
  ]) {
    const [row] = await mysqlRows<{ n: number }>(my, `SELECT COUNT(*) AS n FROM \`${table}\``);
    counts.set(table, Number(row?.n ?? 0));
  }
  for (const [table, n] of counts) if (n > 0) report.count(`mysql.${table}`, n);

  const d1Counts = new Map<string, number>();
  for (const table of [
    'devices',
    'device_credentials',
    'financial_accounts',
    'financial_account_identifiers',
    'raw_sms_events',
    'transaction_candidates',
    'payment_claims',
    'reconciliation_matches',
    'payment_cards',
    'access_users',
    'audit_logs',
    'integration_events',
    'transaction_reviews',
    'transaction_detected_identifiers',
    'transaction_account_assignments',
  ]) {
    d1Counts.set(table, d1Table(cfg, table).length);
  }
  for (const [table, n] of d1Counts) if (n > 0) report.count(`d1.${table}`, n);

  // -------------------------------------------------------------------------
  report.title('closed sets — every legacy value must have a mapping');
  // -------------------------------------------------------------------------
  for (const { table, column, map } of ENUM_CHECKS) {
    // COLLATE utf8mb4_bin is not decoration. MySQL's default collation is
    // case-insensitive, so a plain GROUP BY folds 'Active' and 'active' into
    // one bucket and reports every value as mapped — which is exactly what it
    // did before this was added, while `user` held 5 rows of lowercase
    // 'active' that the transform then refused. The check must be at least as
    // strict as the code it is checking.
    const rows = await mysqlRows<{ v: string | null; n: number }>(
      my,
      `SELECT \`${column}\` COLLATE utf8mb4_bin AS v, COUNT(*) AS n
         FROM \`${table}\` GROUP BY 1`,
    );
    const unmapped = rows.filter((r) => !(String(r.v ?? '') in map));
    if (unmapped.length === 0) {
      report.ok(`${table}.${column} — ${rows.length} distinct values, all mapped`);
    } else {
      for (const u of unmapped) {
        report.fail(`${table}.${column} = ${JSON.stringify(u.v)} (${u.n} rows) has no mapping`);
        add(
          'BLOCKER',
          `${table}.${column}`,
          `unmapped value ${JSON.stringify(u.v)} on ${u.n} rows — add it to transform.ts`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  report.title('referential integrity');
  // -------------------------------------------------------------------------
  const [orphanPayments] = await mysqlRows<{ n: number }>(
    my,
    `SELECT COUNT(*) AS n FROM Payment_report p
      LEFT JOIN user u ON u.id = p.id_user WHERE u.id IS NULL`,
  );
  const orphans = Number(orphanPayments?.n ?? 0);
  if (orphans > 0) {
    report.warn(`${orphans} payments belong to users that no longer exist`);
    report.detail('carried over with user_id NULL and the telegram id preserved');
    add(
      'NOTICE',
      'orphan payments',
      `${orphans} rows keep legacy_telegram_id only — deleting them would move the money total`,
    );
  } else {
    report.ok('every payment has a user');
  }

  const [orphanInvoices] = await mysqlRows<{ n: number }>(
    my,
    `SELECT COUNT(*) AS n FROM invoice i
      LEFT JOIN user u ON u.id = i.id_user WHERE u.id IS NULL`,
  );
  if (Number(orphanInvoices?.n ?? 0) > 0) {
    report.fail(`${orphanInvoices?.n} invoices reference a missing user`);
    add(
      'BLOCKER',
      'orphan invoices',
      'subscriptions.user_id is NOT NULL — these rows cannot be migrated as-is',
    );
  } else {
    report.ok('every invoice has a user');
  }

  const missingPanels = await mysqlRows<{ loc: string; n: number }>(
    my,
    `SELECT i.Service_location AS loc, COUNT(*) AS n FROM invoice i
       LEFT JOIN marzban_panel m ON m.name_panel = i.Service_location
      WHERE i.Service_location IS NOT NULL AND m.id IS NULL
      GROUP BY 1 ORDER BY 2 DESC`,
  );
  if (missingPanels.length > 0) {
    const total = missingPanels.reduce((s, r) => s + Number(r.n), 0);
    report.warn(`${total} subscriptions across ${missingPanels.length} deleted panels`);
    for (const p of missingPanels.slice(0, 5)) report.detail(`${p.n}x  ${p.loc}`);
    add(
      'NOTICE',
      'deleted panels',
      `${total} subscriptions keep provider_name_at_sale with provider_id NULL`,
    );
  } else {
    report.ok('every subscription resolves to a live panel');
  }

  const [leaseCards] = await mysqlRows<{ n: number }>(
    my,
    `SELECT COUNT(*) AS n FROM card_assignment_leases l
       LEFT JOIN card_number c ON c.cardnumber = l.card_number WHERE c.cardnumber IS NULL`,
  );
  if (Number(leaseCards?.n ?? 0) > 0) {
    report.warn(`${leaseCards?.n} leases reference a deleted card`);
    add(
      'NOTICE',
      'lease cards',
      'card_leases.card_number is denormalised text by design, so these survive',
    );
  }

  // -------------------------------------------------------------------------
  report.title('uniqueness the new schema will enforce');
  // -------------------------------------------------------------------------
  const uniqueChecks: [string, string, string][] = [
    ['user', 'id', 'users.telegram_id'],
    ['user', 'codeInvitation', 'users.referral_code'],
    ['invoice', 'id_invoice', 'subscriptions.public_id'],
    ['Payment_report', 'id_order', 'payments.public_id'],
  ];
  for (const [table, column, target] of uniqueChecks) {
    const dupes = await mysqlRows<{ v: string; n: number }>(
      my,
      `SELECT \`${column}\` AS v, COUNT(*) AS n FROM \`${table}\`
        WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''
        GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 5`,
    );
    if (dupes.length === 0) {
      report.ok(`${table}.${column} is unique -> ${target}`);
    } else {
      report.fail(`${table}.${column} has duplicates -> ${target} would reject them`);
      for (const d of dupes) report.detail(`${d.n}x  ${d.v}`);
      add('BLOCKER', `${table}.${column}`, `duplicate values would violate ${target}`);
    }
  }

  // -------------------------------------------------------------------------
  report.title('discount codes — two legacy tables, one code namespace');
  // -------------------------------------------------------------------------
  // Neither legacy table has a unique index on its code, so the same code can
  // exist many times and in both tables at once. The new schema makes the code
  // unique, because a customer types one code and must get one answer.
  const dupCodes = await mysqlRows<{ code: string; n: number; src: string }>(
    my,
    `SELECT code COLLATE utf8mb4_bin AS code, COUNT(*) AS n, 'Discount' AS src
       FROM Discount WHERE code IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
      UNION ALL
     SELECT codeDiscount COLLATE utf8mb4_bin, COUNT(*), 'DiscountSell'
       FROM DiscountSell WHERE codeDiscount IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
      ORDER BY 2 DESC`,
  );
  const crossCodes = await mysqlRows<{ code: string }>(
    my,
    `SELECT DISTINCT d.code COLLATE utf8mb4_bin AS code FROM Discount d
       JOIN DiscountSell s ON s.codeDiscount = d.code`,
  );
  if (dupCodes.length === 0 && crossCodes.length === 0) {
    report.ok('every discount code is unique');
  } else {
    for (const d of dupCodes) {
      report.warn(`${d.src}."${d.code}" exists ${d.n} times`);
    }
    for (const c of crossCodes) {
      report.warn(`"${c.code}" exists in BOTH tables — a gift credit and a percentage`);
    }
    const collapsed = dupCodes.reduce((s, d) => s + Number(d.n) - 1, 0) + crossCodes.length;
    report.detail('kept: most-used first, then gift over sell, then oldest row');
    add(
      'NOTICE',
      'duplicate discount codes',
      `${collapsed} row(s) collapse into their winning code; the losers are ` +
        'reported by the migration and listed in BUGS-FOR-ADMIN.md',
    );
  }

  const badGifts = await mysqlRows<{ id: number; code: string; price: string | null }>(
    my,
    "SELECT id, code, price FROM Discount WHERE price IS NULL OR price = '' OR price = '0'",
  );
  for (const g of badGifts) {
    report.warn(`gift code "${g.code}" credits nothing (price = ${JSON.stringify(g.price)})`);
    add(
      'NOTICE',
      'empty gift code',
      `"${g.code}" credits 0 — the bot already behaves this way, so it is carried over as 0`,
    );
  }

  // -------------------------------------------------------------------------
  report.title('bank cards across both systems');
  // -------------------------------------------------------------------------
  const botCards = (
    await mysqlRows<{ cardnumber: string; namecard: string }>(
      my,
      'SELECT cardnumber, namecard FROM card_number',
    )
  ).map((r) => ({ digits: t.cardDigits(r.cardnumber) ?? '', name: r.namecard }));
  const hubCards = d1Table<{ card_digits: string; financial_account_id: string }>(
    cfg,
    'payment_cards',
  );

  const badBot = botCards.filter((c) => !t.isLuhnValid(c.digits));
  const badHub = hubCards.filter((c) => !t.isLuhnValid(c.card_digits));
  report.step(
    `bot ${botCards.length - badBot.length}/${botCards.length} pass Luhn, ` +
      `hub ${hubCards.length - badHub.length}/${hubCards.length} pass Luhn`,
  );

  for (const c of [...badHub.map((c) => c.card_digits), ...badBot.map((c) => c.digits)]) {
    const fix = cardCorrectionFor(c);
    if (fix) {
      report.warn(`${c} fails Luhn — a known correction rewrites it to ${fix.to}`);
      report.detail(`${fix.reason} (${fix.reference})`);
      add(
        'NOTICE',
        'card correction',
        `${fix.from} -> ${fix.to}: ${fix.reason} [${fix.reference}]`,
      );
    } else {
      report.fail(`card ${c} fails the Luhn check and has no recorded correction`);
      add(
        'BLOCKER',
        'invalid card',
        `${c} is not a valid card number. Either fix it at the source or add a ` +
          'reviewed entry to corrections.ts with the evidence for it.',
      );
    }
  }

  const hubSet = new Set(hubCards.map((c) => correctCardDigits(c.card_digits)));
  const botSet = new Set(botCards.map((c) => c.digits));
  const botOnly = [...botSet].filter((d) => !hubSet.has(d));
  const hubOnly = [...hubSet].filter((d) => !botSet.has(d));
  report.step(`${[...botSet].filter((d) => hubSet.has(d)).length} cards match both systems`);
  if (botOnly.length > 0) {
    report.warn(`${botOnly.length} card(s) only the bot knows: ${botOnly.join(', ')}`);
    add(
      'NOTICE',
      'bot-only cards',
      'these need a financial account before they can join payment_cards ' +
        '(financial_account_id is NOT NULL) — the migration reports and skips them',
    );
  }
  if (hubOnly.length > 0) {
    report.warn(`${hubOnly.length} card(s) only the hub knows: ${hubOnly.join(', ')}`);
  }

  // -------------------------------------------------------------------------
  report.title('target database');
  // -------------------------------------------------------------------------
  const { rows: tableRows } = await pgc.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const tableCount = Number(tableRows[0]?.n ?? 0);
  if (tableCount < 50) {
    report.fail(`only ${tableCount} tables — migrations 0001-0005 are not applied`);
    add('BLOCKER', 'target schema', 'apply migrations/000*.sql first');
  } else {
    report.ok(`${tableCount} tables present`);
  }

  const { rows: existing } = await pgc
    .query<{
      users: string;
      payments: string;
    }>(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM payments) AS payments`)
    .catch(() => ({ rows: [] as { users: string; payments: string }[] }));
  const already = Number(existing[0]?.users ?? 0);
  if (already > 0) {
    report.warn(
      `target already holds ${fmt(already)} users and ` +
        `${fmt(existing[0]?.payments ?? 0)} payments`,
    );
    report.detail('the migration is idempotent — a re-run inserts only what is missing');
  } else {
    report.ok('target is empty');
  }

  // -------------------------------------------------------------------------
  report.title('money in the source');
  // -------------------------------------------------------------------------
  const [balances] = await mysqlRows<{ total: string; negatives: number }>(
    my,
    'SELECT SUM(Balance) AS total, SUM(Balance < 0) AS negatives FROM user',
  );
  const [paid] = await mysqlRows<{ total: string; n: number }>(
    my,
    `SELECT SUM(CAST(price AS SIGNED)) AS total, COUNT(*) AS n
       FROM Payment_report WHERE payment_Status = 'paid'`,
  );
  report.count('Toman  wallet balances', fmt(balances?.total ?? 0));
  report.count('Toman  paid payments', fmt(paid?.total ?? 0));
  report.detail(
    `= ${fmt(BigInt(balances?.total ?? 0) * 10n)} IRR and ` +
      `${fmt(BigInt(paid?.total ?? 0) * 10n)} IRR after conversion`,
  );

  if (Number(balances?.negatives ?? 0) > 0) {
    const neg = await mysqlRows<{ id: string; username: string; Balance: string }>(
      my,
      'SELECT id, username, Balance FROM user WHERE Balance < 0',
    );
    report.warn(`${neg.length} user(s) hold a negative balance`);
    for (const u of neg) report.detail(`${u.id} (${u.username}): ${fmt(u.Balance)} Toman`);
    add(
      'NOTICE',
      'negative balance',
      'carried over exactly — the migration never alters money. ' +
        'Correcting it is a later ledger entry with a named author.',
    );
  }

  return findings;
}

export function summarise(findings: Finding[]): boolean {
  const blockers = findings.filter((f) => f.level === 'BLOCKER');
  const notices = findings.filter((f) => f.level === 'NOTICE');

  report.title(`verdict — ${blockers.length} blocker(s), ${notices.length} notice(s)`);
  for (const f of notices) {
    report.warn(`${f.check}: ${f.detail}`);
  }
  for (const f of blockers) {
    report.fail(`${f.check}: ${f.detail}`);
  }
  if (blockers.length === 0) {
    console.log('\n  Safe to migrate.\n');
    return true;
  }
  console.log('\n  Migration refused. Resolve the blockers above first.\n');
  return false;
}
