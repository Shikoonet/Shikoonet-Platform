/**
 * Financial analytics definitions: verified sales, balances, period comparison.
 */

import { MIRZABOT_SOURCE } from '@hub/contracts';
import { BANK_INCOME_TX_WHERE } from './incomeEligibility.js';
import {
  historyRangeBounds,
  historyRangeDays,
  tehranDayFromUtc,
  type HistoryRange,
} from './historyRange.js';

export { MIRZABOT_SOURCE, BANK_INCOME_TX_WHERE };

/** The settled match row for a verified Mirzabot claim (auto beats manual). */
export const SETTLED_MATCH_SUBQUERY = `
  SELECT m2.id FROM reconciliation_matches m2
   WHERE m2.payment_claim_id = c.id AND m2.status IN ('AUTO_VERIFIED','CONFIRMED')
   ORDER BY CASE m2.status WHEN 'AUTO_VERIFIED' THEN 0 ELSE 1 END, m2.created_at DESC
   LIMIT 1`;

export const VERIFIED_AT = `COALESCE(m.reviewed_at, c.updated_at)`;

export const SALE_CLAIM_WHERE = `
  c.source_system = '${MIRZABOT_SOURCE}'
  AND c.status = 'VERIFIED'`;

export const BOT_SALE_WHERE = `${SALE_CLAIM_WHERE} AND m.status = 'AUTO_VERIFIED'`;

export const MANUAL_SALE_WHERE = `${SALE_CLAIM_WHERE} AND m.status = 'CONFIRMED'`;

export type PercentChange =
  | { kind: 'all_time' }
  | { kind: 'new' }
  | { kind: 'no_baseline' }
  | { kind: 'change'; percent: number };

export function previousHistoryRangeBounds(
  range: HistoryRange,
  nowMs = Date.now(),
): { start: number | null; end: number | null } {
  if (range === 'all') return { start: null, end: null };
  const current = historyRangeBounds(range, nowMs);
  const span = current.end! - current.start!;
  return { start: current.start! - span, end: current.start };
}

export function computePercentChange(current: number, previous: number, range: HistoryRange): PercentChange {
  if (range === 'all') return { kind: 'all_time' };
  if (previous === 0) return current > 0 ? { kind: 'new' } : { kind: 'no_baseline' };
  return { kind: 'change', percent: ((current - previous) / previous) * 100 };
}

export function formatPercentChange(pc: PercentChange): string {
  switch (pc.kind) {
    case 'all_time':
      return 'All-time';
    case 'new':
      return 'New';
    case 'no_baseline':
      return 'No previous-period baseline';
    case 'change': {
      const abs = Math.abs(pc.percent);
      const arrow = pc.percent >= 0 ? '↑' : '↓';
      return `${arrow} ${abs.toFixed(1)}%`;
    }
  }
}

export type TrendBucketKind = 'hour' | 'day' | 'month';

export function trendBucketKind(range: HistoryRange): TrendBucketKind {
  switch (range) {
    case 'today':
    case 'day':
      return 'hour';
    case '2d':
    case '3d':
      return 'day';
    case '7d':
    case '30d':
      return 'day';
    case 'all':
      return 'month';
  }
}

/** Bucket key (start ms) for a verified-at timestamp. */
export function trendBucketStart(verifiedAtMs: number, range: HistoryRange): number {
  const kind = trendBucketKind(range);
  if (kind === 'hour') {
    const d = new Date(verifiedAtMs);
    d.setUTCMinutes(0, 0, 0);
    return d.getTime();
  }
  if (kind === 'day') {
    const { start } = tehranDayFromUtc(verifiedAtMs);
    return start;
  }
  const d = new Date(verifiedAtMs);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() + 3.5 * 60 * 60 * 1000;
}

export function trendBucketLabel(bucketStartMs: number, range: HistoryRange): string {
  const kind = trendBucketKind(range);
  const d = new Date(bucketStartMs);
  if (kind === 'hour') {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  }
  if (kind === 'day') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function salesDistribution(counts: number[]): {
  min: number;
  max: number;
  average: number;
  uneven: boolean;
} {
  if (counts.length === 0) return { min: 0, max: 0, average: 0, uneven: false };
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const average = counts.reduce((a, b) => a + b, 0) / counts.length;
  const uneven = max - min > Math.max(2, average * 0.25);
  return { min, max, average, uneven };
}

export const BALANCE_STALE_MS = 3 * 60 * 60 * 1000;

export function balanceFreshness(asOfMs: number | null, nowMs = Date.now()): 'unavailable' | 'fresh' | 'stale' {
  if (asOfMs == null) return 'unavailable';
  return nowMs - asOfMs <= BALANCE_STALE_MS ? 'fresh' : 'stale';
}

export function historyRangeSpanDays(range: HistoryRange): number | null {
  return historyRangeDays(range);
}
