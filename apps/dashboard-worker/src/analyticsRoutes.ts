import type { D1Database } from '@shikoo/database';
/**
 * Financial analytics API: sales, balances, trends, per-account metrics.
 */

import { Hono } from 'hono';
import {
  BANK_INCOME_TX_WHERE,
  MIRZABOT_SOURCE,
  SETTLED_MATCH_SUBQUERY,
  VERIFIED_AT,
  INCOME_TX_WHERE,
  balanceFreshness,
  cardBalancingDistribution,
  computePercentChange,
  historyRangeBounds,
  parseHistoryRange,
  parseHistoryDay,
  previousHistoryRangeBounds,
  salesDistribution,
  trendBucketLabel,
  trendBucketStart,
  inferPrimaryDevice,
  tehranTodayDateString,
  type HistoryRange,
  type PercentChange,
} from '@shikoo/domain';
import { loadFinancialSummary } from './paymentsHubRoutes.js';
import {
  CARD_ACTIVITY_WINDOWS,
  type CardActivityCounts,
  type CardActivityWindowKey,
} from '@shikoo/contracts';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

function rangeSql(
  column: string,
  start: number | null,
  end: number | null,
  p: (v: unknown) => string,
): string {
  if (start == null || end == null) return '';
  return ` AND ${column} >= ${p(start)} AND ${column} < ${p(end)}`;
}

type SalesRow = {
  sales_count: number;
  sales_amount_irr: number;
  bot_count: number;
  bot_amount_irr: number;
  manual_count: number;
  manual_amount_irr: number;
};

async function loadSalesMetrics(
  db: D1Database,
  start: number | null,
  end: number | null,
  accountId?: string,
): Promise<SalesRow> {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  let where = `c.source_system = ${p(MIRZABOT_SOURCE)} AND c.status = 'VERIFIED'`;
  if (accountId) where += ` AND c.target_financial_account_id = ${p(accountId)}`;
  where += rangeSql(VERIFIED_AT, start, end, p);

  const row = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT c.id) AS sales_count,
         COALESCE(SUM(c.expected_amount_irr), 0) AS sales_amount_irr,
         COUNT(DISTINCT CASE WHEN m.status = 'AUTO_VERIFIED' THEN c.id END) AS bot_count,
         COALESCE(SUM(CASE WHEN m.status = 'AUTO_VERIFIED' THEN c.expected_amount_irr ELSE 0 END), 0) AS bot_amount_irr,
         COUNT(DISTINCT CASE WHEN m.status = 'CONFIRMED' THEN c.id END) AS manual_count,
         COALESCE(SUM(CASE WHEN m.status = 'CONFIRMED' THEN c.expected_amount_irr ELSE 0 END), 0) AS manual_amount_irr
       FROM payment_claims c
       JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH_SUBQUERY})
       WHERE ${where}`,
    )
    .bind(...binds)
    .first<SalesRow>();
  return (
    row ?? {
      sales_count: 0,
      sales_amount_irr: 0,
      bot_count: 0,
      bot_amount_irr: 0,
      manual_count: 0,
      manual_amount_irr: 0,
    }
  );
}

async function loadSalesTrend(
  db: D1Database,
  range: HistoryRange,
  start: number | null,
  end: number | null,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  let where = `c.source_system = ${p(MIRZABOT_SOURCE)} AND c.status = 'VERIFIED'`;
  where += rangeSql(VERIFIED_AT, start, end, p);

  const rows = await db
    .prepare(
      `SELECT c.expected_amount_irr, ${VERIFIED_AT} AS verified_at
       FROM payment_claims c
       JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH_SUBQUERY})
       WHERE ${where}`,
    )
    .bind(...binds)
    .all<{ expected_amount_irr: number; verified_at: number }>();

  const buckets = new Map<number, { salesCount: number; salesAmountIrr: number }>();
  for (const r of rows.results ?? []) {
    const key = trendBucketStart(r.verified_at, range);
    const b = buckets.get(key) ?? { salesCount: 0, salesAmountIrr: 0 };
    b.salesCount += 1;
    b.salesAmountIrr += r.expected_amount_irr;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, v]) => ({
      bucketStart,
      label: trendBucketLabel(bucketStart, range),
      salesCount: v.salesCount,
      salesAmountIrr: v.salesAmountIrr,
    }));
}

async function loadAccountBalances(db: D1Database, now: number) {
  const rows = await db
    .prepare(
      `SELECT fa.id, fa.display_name, fa.owner_label, fa.bank_name, fa.account_hint, fa.status,
              bal.balance_irr, bal.bank_timestamp
       FROM financial_accounts fa
       LEFT JOIN (
         SELECT t.financial_account_id, t.balance_irr, t.bank_timestamp,
                ROW_NUMBER() OVER (
                  PARTITION BY t.financial_account_id
                  ORDER BY t.bank_timestamp DESC, t.created_at DESC
                ) AS rn
         FROM transaction_candidates t
         WHERE t.balance_irr IS NOT NULL
       ) bal ON bal.financial_account_id = fa.id AND bal.rn = 1
       WHERE fa.active = 1 AND fa.status = 'ACTIVE'
       ORDER BY fa.display_name ASC`,
    )
    .all<{
      id: string;
      display_name: string;
      owner_label: string | null;
      bank_name: string;
      account_hint: string | null;
      status: string;
      balance_irr: number | null;
      bank_timestamp: number | null;
    }>();

  let totalKnownIrr = 0;
  let knownAccounts = 0;
  const accounts = (rows.results ?? []).map((r) => {
    const hasBalance = r.balance_irr != null;
    if (hasBalance) {
      totalKnownIrr += r.balance_irr!;
      knownAccounts += 1;
    }
    return {
      accountId: r.id,
      displayName: r.display_name,
      ownerLabel: r.owner_label,
      bankName: r.bank_name,
      accountHint: r.account_hint,
      status: r.status,
      currentBalanceIrr: hasBalance ? r.balance_irr : null,
      balanceAsOf: r.bank_timestamp,
      balanceFreshness: balanceFreshness(r.bank_timestamp, now),
    };
  });

  return {
    totalKnownIrr,
    knownAccounts,
    totalActiveAccounts: accounts.length,
    accounts,
  };
}

async function loadAccountBankInflow(
  db: D1Database,
  accountId: string,
  start: number | null,
  end: number | null,
) {
  const binds: unknown[] = [accountId];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeSql('t.bank_timestamp', start, end, p);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_irr), 0) AS amount_irr, COUNT(*) AS count
       FROM transaction_candidates t
       WHERE t.financial_account_id = ?1 AND ${BANK_INCOME_TX_WHERE}${rangeFilter}`,
    )
    .bind(...binds)
    .first<{ amount_irr: number; count: number }>();
  return { amountIrr: row?.amount_irr ?? 0, count: row?.count ?? 0 };
}

async function loadAccountUnassignedIncome(
  db: D1Database,
  accountId: string,
  start: number | null,
  end: number | null,
) {
  const binds: unknown[] = [accountId];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeSql('t.bank_timestamp', start, end, p);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_irr), 0) AS amount_irr, COUNT(*) AS count
       FROM transaction_candidates t
       WHERE t.financial_account_id = ?1 AND ${INCOME_TX_WHERE}${rangeFilter}`,
    )
    .bind(...binds)
    .first<{ amount_irr: number; count: number }>();
  return { amountIrr: row?.amount_irr ?? 0, count: row?.count ?? 0 };
}

async function loadAccountReseller(
  db: D1Database,
  accountId: string,
  start: number | null,
  end: number | null,
) {
  const binds: unknown[] = [accountId];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeSql('rt.classified_at', start, end, p);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_irr), 0) AS amount_irr, COUNT(*) AS count
       FROM reseller_transactions rt
       JOIN transaction_candidates t ON t.id = rt.transaction_candidate_id
       WHERE t.financial_account_id = ?1${rangeFilter}`,
    )
    .bind(...binds)
    .first<{ amount_irr: number; count: number }>();
  return { amountIrr: row?.amount_irr ?? 0, count: row?.count ?? 0 };
}

export async function loadAnalytics(
  db: D1Database,
  range: HistoryRange,
  now = Date.now(),
  day?: string | null,
) {
  const { start, end } = historyRangeBounds(range, now, day);
  const prev = previousHistoryRangeBounds(range, now);

  const [currentSales, previousSales, summary, trend, balances] = await Promise.all([
    loadSalesMetrics(db, start, end),
    loadSalesMetrics(db, prev.start, prev.end),
    loadFinancialSummary(db, range, now, day),
    loadSalesTrend(db, range, start, end),
    loadAccountBalances(db, now),
  ]);

  const salesChange = computePercentChange(
    currentSales.sales_amount_irr,
    previousSales.sales_amount_irr,
    range,
  );
  const salesCountChange = computePercentChange(
    currentSales.sales_count,
    previousSales.sales_count,
    range,
  );

  return {
    range,
    sales: {
      count: currentSales.sales_count,
      amountIrr: currentSales.sales_amount_irr,
      amountChange: salesChange,
      countChange: salesCountChange,
    },
    botAutoVerified: {
      count: currentSales.bot_count,
      amountIrr: currentSales.bot_amount_irr,
    },
    manualVerified: {
      count: currentSales.manual_count,
      amountIrr: currentSales.manual_amount_irr,
    },
    bankInflowIrr: summary.bankIncomeIrr,
    reseller: {
      count: summary.reseller.payments,
      amountIrr: summary.reseller.amountIrr,
    },
    unassignedIncome: summary.unassignedIncome,
    balances: {
      totalKnownIrr: balances.totalKnownIrr,
      knownAccounts: balances.knownAccounts,
      totalActiveAccounts: balances.totalActiveAccounts,
    },
    trend,
  };
}

async function loadAccountDeviceObservations(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT t.financial_account_id, r.device_id, t.bank_timestamp
       FROM transaction_candidates t
       JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
       WHERE t.financial_account_id IS NOT NULL
         AND t.status = 'PARSED'
         AND r.device_id IS NOT NULL
       ORDER BY t.financial_account_id, t.bank_timestamp DESC`,
    )
    .all<{ financial_account_id: string; device_id: string; bank_timestamp: number }>();

  const byAccount = new Map<string, Array<{ deviceId: string; bankTimestamp: number }>>();
  for (const r of rows.results ?? []) {
    const list = byAccount.get(r.financial_account_id) ?? [];
    if (list.length >= 20) continue;
    list.push({ deviceId: r.device_id, bankTimestamp: r.bank_timestamp });
    byAccount.set(r.financial_account_id, list);
  }
  return byAccount;
}

async function loadDevicesLookup(db: D1Database) {
  const rows = await db
    .prepare(`SELECT id, display_name, device_code FROM devices`)
    .all<{ id: string; display_name: string; device_code: string }>();
  return new Map(
    (rows.results ?? []).map((d) => [
      d.id,
      { displayName: d.display_name, deviceCode: d.device_code },
    ]),
  );
}

export async function loadAccountAnalytics(
  db: D1Database,
  range: HistoryRange,
  now = Date.now(),
  day?: string | null,
) {
  const { start, end } = historyRangeBounds(range, now, day);
  const balanceData = await loadAccountBalances(db, now);
  const [cardCounts, deviceObservations, devicesLookup] = await Promise.all([
    db
      .prepare(
        `SELECT financial_account_id, COUNT(*) AS n
         FROM payment_cards GROUP BY financial_account_id`,
      )
      .all<{ financial_account_id: string; n: number }>(),
    loadAccountDeviceObservations(db),
    loadDevicesLookup(db),
  ]);
  const cardsByAccount = new Map(
    (cardCounts.results ?? []).map((r) => [r.financial_account_id, r.n]),
  );

  const items = [];
  for (const acc of balanceData.accounts) {
    const [sales, bankInflow, unassigned, reseller] = await Promise.all([
      loadSalesMetrics(db, start, end, acc.accountId),
      loadAccountBankInflow(db, acc.accountId, start, end),
      loadAccountUnassignedIncome(db, acc.accountId, start, end),
      loadAccountReseller(db, acc.accountId, start, end),
    ]);
    items.push({
      accountId: acc.accountId,
      displayName: acc.displayName,
      ownerLabel: acc.ownerLabel,
      bankName: acc.bankName,
      accountHint: acc.accountHint,
      status: acc.status,
      mappedCards: cardsByAccount.get(acc.accountId) ?? 0,
      currentBalanceIrr: acc.currentBalanceIrr,
      balanceAsOf: acc.balanceAsOf,
      balanceFreshness: acc.balanceFreshness,
      purchaseCount: sales.bot_count,
      salesCount: sales.sales_count,
      salesAmountIrr: sales.sales_amount_irr,
      transactionCount: bankInflow.count,
      bankInflowIrr: bankInflow.amountIrr,
      bankInflowCount: bankInflow.count,
      unassignedIncomeIrr: unassigned.amountIrr,
      unassignedIncomeCount: unassigned.count,
      resellerAmountIrr: reseller.amountIrr,
      resellerCount: reseller.count,
      ...inferPrimaryDevice(deviceObservations.get(acc.accountId) ?? [], devicesLookup),
    });
  }

  items.sort((a, b) => {
    if (b.purchaseCount !== a.purchaseCount) return b.purchaseCount - a.purchaseCount;
    if (b.salesAmountIrr !== a.salesAmountIrr) return b.salesAmountIrr - a.salesAmountIrr;
    return a.accountId.localeCompare(b.accountId);
  });

  const purchaseCounts = items.map((i) => i.purchaseCount);
  const distribution = salesDistribution(purchaseCounts);
  const maxPurchases = Math.max(...purchaseCounts, 1);

  return {
    range,
    totals: {
      totalKnownBalanceIrr: balanceData.totalKnownIrr,
      knownAccounts: balanceData.knownAccounts,
      totalActiveAccounts: balanceData.totalActiveAccounts,
    },
    distribution: {
      min: distribution.min,
      average: Math.round(distribution.average * 10) / 10,
      max: distribution.max,
      uneven: distribution.uneven,
    },
    items: items.map((i) => ({
      ...i,
      purchaseBarPercent: Math.round((i.purchaseCount / maxPurchases) * 100),
    })),
  };
}

/** Per-card Hub verified purchases (diagnostic — not assignment lease counts). */
export async function loadCardAnalytics(
  db: D1Database,
  range: HistoryRange,
  now = Date.now(),
  day?: string | null,
) {
  const { start, end } = historyRangeBounds(range, now, day);
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeSql(VERIFIED_AT, start, end, p);

  // The six activity windows are deliberately NOT scoped by the page's range.
  // They answer «is this card busy right now», and a «۳۰ روز» column that
  // shrank to nothing because the operator picked «امروز» would be a number
  // under a label it does not mean. So the range moves off the JOIN and into
  // `purchase_count`'s own CASE, and each window brings its own cut-off.
  const windowSql = CARD_ACTIVITY_WINDOWS.map(
    (w) =>
      `COUNT(DISTINCT CASE WHEN m.status = 'AUTO_VERIFIED'` +
      ` AND ${VERIFIED_AT} >= ${p(now - w.hours * 3_600_000)}` +
      ` THEN c.id END) AS w_${w.key}`,
  ).join(', ');

  const rows = await db
    .prepare(
      `SELECT pc.card_digits,
              pc.display_weight,
              fa.id AS account_id,
              fa.display_name,
              fa.owner_label,
              fa.account_hint,
              fa.status AS account_status,
              COUNT(DISTINCT CASE WHEN m.status = 'AUTO_VERIFIED'${rangeFilter}
                                  THEN c.id END) AS purchase_count,
              -- «چقدر به کارت ملت رفت، و کدام کاربرها ریختند» -- Sam,
              -- 2026-09-02. Summed here rather than in a route of its own:
              -- this query already scans exactly the rows the question is
              -- about, so a second endpoint would be a second scan and a
              -- second place to keep in step with this one.
              --
              -- Deliberately a WIDER population than purchase_count beside it.
              -- That column counts only AUTO_VERIFIED matches, because it
              -- exists to judge whether card rotation is fair. Money does not
              -- care who approved it: a claim an operator confirmed by hand
              -- put the same rials on the same card. So these three agree with
              -- each other and are counted over every settled claim naming the
              -- card, and verified_count is here so the amount is never read
              -- against a count that means something else.
              COUNT(DISTINCT CASE WHEN c.id IS NOT NULL${rangeFilter}
                                  THEN c.id END) AS verified_count,
              COALESCE(SUM(CASE WHEN c.id IS NOT NULL${rangeFilter}
                                THEN c.expected_amount_irr END), 0) AS takings_irr,
              COUNT(DISTINCT CASE WHEN c.id IS NOT NULL${rangeFilter}
                                  THEN c.customer_reference END) AS unique_customers,
              ${windowSql}
       FROM payment_cards pc
       JOIN financial_accounts fa ON fa.id = pc.financial_account_id
       LEFT JOIN payment_claims c
         -- The CARD the claim named, not the card's account. Joining on the
         -- account made every card of a multi-card account report that
         -- account's total under its own name -- an account figure printed
         -- once per card, and identical across the account's cards.
         -- payment_claims.card_digits is snapshotted on every claim, is
         -- indexed (idx_claim_card_digits), and joins UNIQUE-ly to
         -- payment_cards.card_digits.
         ON c.card_digits = pc.card_digits
        AND c.source_system = ${p(MIRZABOT_SOURCE)}
        AND c.status = 'VERIFIED'
       LEFT JOIN reconciliation_matches m
         ON m.payment_claim_id = c.id
        AND m.status = 'AUTO_VERIFIED'
       WHERE fa.active = 1
       -- fa.id is financial_accounts' primary key, so Postgres accepts the
       -- other fa.* columns by functional dependency. SQLite allowed the bare
       -- columns and picked an arbitrary row per group; that only happened to
       -- be right because a card belongs to exactly one account.
       GROUP BY pc.card_digits, pc.display_weight, fa.id
       ORDER BY purchase_count DESC, pc.card_digits ASC`,
    )
    .bind(...binds)
    .all<{
      card_digits: string;
      display_weight: number;
      account_id: string;
      display_name: string;
      owner_label: string | null;
      account_hint: string | null;
      account_status: string;
      purchase_count: number;
      verified_count: number;
      takings_irr: number;
      unique_customers: number;
    } & Record<`w_${CardActivityWindowKey}`, number>>();

  const items = (rows.results ?? []).map((r) => ({
    cardDigits: r.card_digits,
    cardMasked: `****${r.card_digits.slice(-4)}`,
    // Sits beside the count on purpose: the count is how far behind a card is,
    // the weight is how fast it is catching up, and the admin needs both in one
    // place to decide when to set the weight back to 1.
    displayWeight: r.display_weight,
    accountId: r.account_id,
    displayName: r.display_name,
    ownerLabel: r.owner_label,
    accountHint: r.account_hint,
    accountStatus: r.account_status,
    purchaseCount: r.purchase_count,
    // Money, and a count that matches it. `SUM` on the SQL side rather than a
    // `reduce` in the browser: the browser only ever holds the rows it was
    // sent, so a total assembled there is a total of one page.
    verifiedCount: r.verified_count,
    takingsIrr: Number(r.takings_irr ?? 0),
    uniqueCustomers: r.unique_customers,
    // Numbers, not a nested query per card: one scan produces all six.
    activity: Object.fromEntries(
      CARD_ACTIVITY_WINDOWS.map((w) => [w.key, Number(r[`w_${w.key}`] ?? 0)]),
    ) as CardActivityCounts,
    hubEligible: r.account_status === 'ACTIVE',
    exclusionReason:
      r.account_status === 'ACTIVE' ? 'hub_active' : `account_${r.account_status.toLowerCase()}`,
  }));

  const purchaseCounts = items.map((i) => i.purchaseCount);
  const distribution = cardBalancingDistribution(purchaseCounts);
  const maxPurchases = Math.max(...purchaseCounts, 1);

  return {
    range,
    entity: 'card_number' as const,
    metric: 'hub_auto_verified_purchases' as const,
    // Sent rather than duplicated in the panel: the headers and the counts
    // come from one list, so a seventh window cannot appear on one side only.
    windows: CARD_ACTIVITY_WINDOWS,
    // Sent to the browser and rendered verbatim, so it is written in the
    // language the screen is in.
    note: 'خریدهای تاییدشده به تفکیک کارت نگاشت‌شده. توازن تخصیص کارت بر پایهٔ اجاره‌های تکمیل‌شدهٔ ربات است، نه این نمودار.',
    distribution,
    items: items.map((i) => ({
      ...i,
      purchaseBarPercent: Math.round((i.purchaseCount / maxPurchases) * 100),
    })),
  };
}

export function registerAnalyticsRoutes(
  app: Hono<{
    Bindings: { DB: D1Database };
    Variables: { identity: Ident };
  }>,
) {
  app.get('/api/v1/analytics', async (c) => {
    const range = parseHistoryRange(c.req.query('range'));
    const day =
      range === 'day'
        ? (parseHistoryDay(c.req.query('day')) ?? tehranTodayDateString())
        : parseHistoryDay(c.req.query('day'));
    const data = await loadAnalytics(c.env.DB, range, Date.now(), day);
    return c.json({ ok: true, ...data, day: range === 'day' ? day : null });
  });

  app.get('/api/v1/accounts/analytics', async (c) => {
    const range = parseHistoryRange(c.req.query('range'));
    const day =
      range === 'day'
        ? (parseHistoryDay(c.req.query('day')) ?? tehranTodayDateString())
        : parseHistoryDay(c.req.query('day'));
    const data = await loadAccountAnalytics(c.env.DB, range, Date.now(), day);
    return c.json({ ok: true, ...data, day: range === 'day' ? day : null });
  });

  app.get('/api/v1/cards/analytics', async (c) => {
    const range = parseHistoryRange(c.req.query('range'));
    const day =
      range === 'day'
        ? (parseHistoryDay(c.req.query('day')) ?? tehranTodayDateString())
        : parseHistoryDay(c.req.query('day'));
    const data = await loadCardAnalytics(c.env.DB, range, Date.now(), day);
    return c.json({ ok: true, ...data, day: range === 'day' ? day : null });
  });
}

export type { PercentChange };
