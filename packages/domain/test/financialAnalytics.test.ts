import { describe, expect, it } from 'vitest';
import {
  computePercentChange,
  formatPercentChange,
  previousHistoryRangeBounds,
  salesDistribution,
  trendBucketKind,
  trendBucketStart,
  trendBucketLabel,
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

describe('a bucket label names the Tehran day, on any host', () => {
  // Tehran midnight on 23 August 2026 is 20:30 UTC on the 22nd. Formatted in
  // the host's zone that reads «Aug 22» -- one day early, on a money chart,
  // rendered by a container that has no TZ set.
  const TEHRAN_MIDNIGHT_23_AUG = Date.UTC(2026, 7, 22, 20, 30, 0);

  it('is the day Tehran is on, not the day UTC is on', () => {
    expect(new Date(TEHRAN_MIDNIGHT_23_AUG).toISOString().slice(0, 10)).toBe('2026-08-22');
    expect(trendBucketLabel(TEHRAN_MIDNIGHT_23_AUG, '7d')).toBe('Aug 23');
    expect(trendBucketLabel(TEHRAN_MIDNIGHT_23_AUG, 'month')).toBe('Aug 23');
  });

  it('reads the same whatever locale or zone the host is set to', () => {
    // The locale is pinned as well as the zone: `undefined` meant the
    // container's, so a base-image change could relabel a chart with nothing
    // in the diff. Asserting an exact string is what makes this test bite on a
    // Tehran laptop AND on a UTC runner -- the first version asserted the day
    // number against `Intl` and would have passed on my machine either way.
    expect(trendBucketLabel(Date.UTC(2026, 7, 22, 20, 30, 0), 'all')).toBe('Aug 2026');
    expect(trendBucketLabel(Date.UTC(2026, 7, 22, 20, 30, 0), 'today')).toBe('Aug 23, 12 AM');
  });
});
