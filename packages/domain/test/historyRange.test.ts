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

/**
 * Ground-truth checks against the IANA timezone database.
 *
 * The rest of this file only ever asserted that the range helpers agree with
 * each other, which is why a seven-hour error in the Tehran day survived. These
 * compare against what Asia/Tehran actually says.
 *
 * Iran abolished DST in 2022, so the fixed +3:30 offset is right for every date
 * this platform handles. A pre-2022 date would need the tz database.
 */
describe('tehranDayFromUtc against the tz database', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const tehranClock = (ms: number) => fmt.format(new Date(ms));

  it('starts exactly at Tehran midnight, whatever the hour in UTC', () => {
    for (const hour of [0, 1, 3, 4, 8, 12, 16, 20, 23]) {
      const ms = Date.UTC(2026, 7, 11, hour, 30, 0);
      const { start } = tehranDayFromUtc(ms);
      expect(tehranClock(start)).toMatch(/00:00:00$/);
    }
  });

  it('puts the instant inside its own day', () => {
    // The previous implementation returned a window starting hours in the
    // future for any instant before 07:00 Tehran, so /api/v1/today was empty.
    for (const hour of [0, 1, 3, 4, 8, 12, 16, 20, 23]) {
      const ms = Date.UTC(2026, 7, 11, hour, 30, 0);
      const { start, end } = tehranDayFromUtc(ms);
      expect(ms).toBeGreaterThanOrEqual(start);
      expect(ms).toBeLessThan(end);
    }
  });

  it('agrees with the Tehran calendar date of the instant', () => {
    for (const hour of [0, 5, 12, 21, 23]) {
      const ms = Date.UTC(2026, 7, 11, hour, 30, 0);
      const { start } = tehranDayFromUtc(ms);
      expect(tehranClock(start).slice(0, 10)).toBe(tehranClock(ms).slice(0, 10));
    }
  });

  it('spans exactly 24 hours and tiles without gaps', () => {
    const a = tehranDayFromUtc(Date.UTC(2026, 7, 11, 12, 0, 0));
    const b = tehranDayFromUtc(a.end);
    expect(a.end - a.start).toBe(24 * 60 * 60 * 1000);
    expect(b.start).toBe(a.end);
  });

  it('resolves an explicit YYYY-MM-DD to that Tehran day', () => {
    const { start } = tehranDayBoundsFromDate('2026-08-07');
    expect(tehranClock(start)).toBe('2026-08-07, 00:00:00');
  });
});
