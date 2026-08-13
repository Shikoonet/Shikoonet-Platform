/**
 * Loading the operator-editable bank patterns.
 *
 * The parsing rules live in `@shikoo/sms-parser`, which has no database of its
 * own by design. This is the one place that reads the rows, so ingest and the
 * dashboard's test box compile the same set from the same query — a test box
 * that consults a different list than production is worse than no test box.
 */

import type { D1Database } from '@shikoo/database';
import type { BankSmsPatternRow } from '@shikoo/sms-parser';

/**
 * Every enabled pattern, lowest priority first.
 *
 * Read on each SMS rather than cached. There are a handful of rows behind a
 * partial index, the path already runs several queries, and the alternative is
 * a stale answer in the minutes after an admin fixes a bank that just changed
 * its wording — which is the exact moment the fix needs to be live.
 */
export async function loadBankSmsPatterns(db: D1Database): Promise<BankSmsPatternRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, bank_name, priority, detect_re, amount_re, amount_unit,
              direction, balance_re, account_re
         FROM bank_sms_patterns
        WHERE enabled
        ORDER BY priority, id`,
    )
    .all<{
      id: string;
      bank_name: string;
      priority: number;
      detect_re: string;
      amount_re: string;
      amount_unit: string;
      direction: string;
      balance_re: string | null;
      account_re: string | null;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    bankName: r.bank_name,
    priority: r.priority,
    detectRe: r.detect_re,
    amountRe: r.amount_re,
    // The column has a CHECK, so these casts restate a constraint the database
    // already enforces rather than assuming anything about the data.
    amountUnit: r.amount_unit === 'TOMAN' ? 'TOMAN' : 'IRR',
    direction: r.direction === 'DEBIT' ? 'DEBIT' : 'CREDIT',
    balanceRe: r.balance_re,
    accountRe: r.account_re,
  }));
}
