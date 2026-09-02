/**
 * Financial analytics definitions: verified sales, balances, period comparison.
 */

import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { BANK_INCOME_TX_WHERE } from './incomeEligibility.js';
import {
  historyRangeBounds,
  jalaliMonthBounds,
  jalaliMonthStart,
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
  // A month compares against the month before it, not against «the same number
  // of days, earlier». Subtracting the span would set 31-day Mordad against the
  // 31 days ending on 1 Mordad -- a window straddling two months, under a label
  // saying «previous period». Jalali months are 29 to 31 days, so the two are
  // never the same window and are sometimes two days apart.
  if (range === 'month') return jalaliMonthBounds(jalaliMonthStart(nowMs) - 1);
  if (range === 'prev_month') {
    return jalaliMonthBounds(jalaliMonthStart(jalaliMonthStart(nowMs) - 1) - 1);
  }
  const current = historyRangeBounds(range, nowMs);
  const span = current.end! - current.start!;
  return { start: current.start! - span, end: current.start };
}

export function computePercentChange(
  current: number,
  previous: number,
  range: HistoryRange,
): PercentChange {
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
    // A Jalali month buckets by day, like `30d`. By month would be one bar.
    case 'month':
    case 'prev_month':
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

/**
 * The axis label for a bucket — Tehran, and the same on every host.
 *
 * Both halves of that were wrong, and this is called from the SERVER
 * (`analyticsRoutes.ts`), so the container decided the answer.
 *
 * **The zone.** `trendBucketStart` returns Tehran day starts, and Tehran
 * midnight is 20:30 UTC the day BEFORE. Formatted in the host's zone on a UTC
 * container -- which is what our image is, nothing sets `TZ` -- the bucket
 * beginning Tehran-midnight on 23 Mordad was labelled «Aug 22». Every daily
 * bucket on the money trend chart named the wrong day, and had done since the
 * chart was built; CodeRabbit caught it on #67 while reading the two month
 * cases added here.
 *
 * **The locale.** `undefined` means the host's, so the same figures could be
 * labelled differently after a base-image change, with nothing in the code
 * recording that anything had moved. A label the server renders has to be the
 * server's decision. `en-US` because that is what the container has been
 * producing and this commit is fixing a date, not redesigning an axis --
 * a Persian, Jalali axis is a real question and belongs to whoever asks it.
 */
const BUCKET_TZ = 'Asia/Tehran';

export function trendBucketLabel(bucketStartMs: number, range: HistoryRange): string {
  const kind = trendBucketKind(range);
  const d = new Date(bucketStartMs);
  if (kind === 'hour') {
    return d.toLocaleString('en-US', {
      timeZone: BUCKET_TZ,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
    });
  }
  if (kind === 'day') {
    return d.toLocaleDateString('en-US', { timeZone: BUCKET_TZ, month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { timeZone: BUCKET_TZ, month: 'short', year: 'numeric' });
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

export function balanceFreshness(
  asOfMs: number | null,
  nowMs = Date.now(),
): 'unavailable' | 'fresh' | 'stale' {
  if (asOfMs == null) return 'unavailable';
  return nowMs - asOfMs <= BALANCE_STALE_MS ? 'fresh' : 'stale';
}

