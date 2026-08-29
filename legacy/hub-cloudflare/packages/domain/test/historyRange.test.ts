import { describe, expect, it } from 'vitest';
import {
  historyRangeBounds,
  parseHistoryRange,
  tehranDayFromUtc,
  tehranDayBoundsFromDate,
  tehranAdjacentDay,
} from '../src/historyRange.js';

describe('historyRange', () => {
  it('defaults to all', () => {
    expect(parseHistoryRange(null)).toBe('all');
    expect(parseHistoryRange(undefined)).toBe('all');
  });

  it('accepts day range', () => {
    expect(parseHistoryRange('day')).toBe('day');
  });

  it('today uses one Tehran day', () => {
    const now = Date.parse('2026-08-07T12:00:00Z');
    const day = tehranDayFromUtc(now);
    const bounds = historyRangeBounds('today', now);
    expect(bounds.start).toBe(day.start);
    expect(bounds.end).toBe(day.end);
  });

  it('selected day uses explicit YYYY-MM-DD bounds', () => {
    const bounds = historyRangeBounds('day', Date.now(), '2026-08-07');
    const direct = tehranDayBoundsFromDate('2026-08-07');
    expect(bounds.start).toBe(direct.start);
    expect(bounds.end).toBe(direct.end);
  });

  it('adjacent day navigation steps one Tehran day', () => {
    expect(tehranAdjacentDay('2026-08-07', -1)).toBe('2026-08-06');
    expect(tehranAdjacentDay('2026-08-07', 1)).toBe('2026-08-08');
  });

  it('last 7 days spans seven Tehran days ending today', () => {
    const now = Date.parse('2026-08-07T12:00:00Z');
    const { start: todayStart, end: todayEnd } = tehranDayFromUtc(now);
    const bounds = historyRangeBounds('7d', now);
    expect(bounds.start).toBe(todayStart - 6 * 24 * 60 * 60 * 1000);
    expect(bounds.end).toBe(todayEnd);
  });

  it('all has null bounds', () => {
    expect(historyRangeBounds('all')).toEqual({ start: null, end: null });
  });
});
