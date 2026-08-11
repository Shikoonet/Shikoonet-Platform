import { describe, expect, it } from 'vitest';
import {
  computePercentChange,
  formatPercentChange,
  previousHistoryRangeBounds,
  salesDistribution,
  trendBucketKind,
  trendBucketStart,
} from '../src/financialAnalytics.js';
import { historyRangeBounds } from '../src/historyRange.js';

describe('financialAnalytics', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');

  it('previousHistoryRangeBounds for 7d', () => {
    const current = historyRangeBounds('7d', now);
    const prev = previousHistoryRangeBounds('7d', now);
    expect(prev.end).toBe(current.start);
    expect(current.start! - prev.start!).toBe(current.end! - current.start!);
  });

  it('computePercentChange avoids Infinity when previous is 0', () => {
    expect(computePercentChange(100, 0, 'today')).toEqual({ kind: 'new' });
    expect(computePercentChange(0, 0, 'today')).toEqual({ kind: 'no_baseline' });
    expect(computePercentChange(50, 0, 'all')).toEqual({ kind: 'all_time' });
  });

  it('computePercentChange calculates change', () => {
    const pc = computePercentChange(112, 100, '7d');
    expect(pc).toEqual({ kind: 'change', percent: 12 });
    expect(formatPercentChange(pc)).toBe('↑ 12.0%');
    expect(formatPercentChange(computePercentChange(93, 100, '7d'))).toBe('↓ 7.0%');
  });

  it('trend buckets vary by range', () => {
    expect(trendBucketKind('today')).toBe('hour');
    expect(trendBucketKind('7d')).toBe('day');
    expect(trendBucketKind('all')).toBe('month');
    expect(trendBucketStart(now, 'today')).toBeLessThanOrEqual(now);
  });

  it('salesDistribution flags uneven spread', () => {
    expect(salesDistribution([16, 17, 18]).uneven).toBe(false);
    expect(salesDistribution([5, 18]).uneven).toBe(true);
  });
});
