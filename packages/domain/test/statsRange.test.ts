/**
 * These bounds are checked against `Intl` on `Asia/Tehran`, never against the
 * function that produced them.
 *
 * That is not a stylistic preference here. `historyRange.ts` shipped a
 * «Tehran day» that was seven hours out for every day of every year, and its
 * tests were green the whole time because they asserted that one export agreed
 * with another. The outside truth for a timezone is the platform's own
 * timezone database, so every assertion below formats the boundary and reads
 * the wall clock back.
 *
 * The month cases walk 400 consecutive days — more than one Jalali year — so a
 * leap rule or a 31/30-day boundary cannot hide behind a single lucky date.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStatsRange, statsRangeBounds, type StatsRange } from '../src/statsRange.js';

/** 2026-08-29T08:00:00Z — a Saturday, mid-Shahrivar 1405. */
const NOW_MS = Date.UTC(2026, 7, 29, 8, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const wall = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tehran',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const gregorian = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const jalali = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/** `{ year, month, day }` in the Jalali calendar, as numbers. */
function jalaliParts(ms: number): { year: number; month: number; day: number } {
  const p = Object.fromEntries(jalali.formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the day-shaped windows start at Tehran midnight', () => {
  for (const range of ['today', 'yesterday'] as const) {
    it(`${range} opens and closes at 00:00:00 Tehran`, () => {
      const { start, end } = statsRangeBounds(range);
      expect(wall.format(start!)).toBe('00:00:00');
      expect(wall.format(end!)).toBe('00:00:00');
      expect(end! - start!).toBe(DAY_MS);
    });
  }

  it('yesterday is the calendar day before today, and they do not overlap', () => {
    const today = statsRangeBounds('today');
    const yesterday = statsRangeBounds('yesterday');

    expect(yesterday.end).toBe(today.start);
    expect(gregorian.format(today.start!)).toBe('2026-08-29');
    expect(gregorian.format(yesterday.start!)).toBe('2026-08-28');
  });

  it('a named day resolves to that Tehran date, not to the UTC one', () => {
    const { start, end } = statsRangeBounds('day', NOW_MS, '2026-03-21');
    expect(gregorian.format(start!)).toBe('2026-03-21');
    expect(wall.format(start!)).toBe('00:00:00');
    expect(end! - start!).toBe(DAY_MS);
  });
});

describe('the last hour is an hour', () => {
  it('ends now and is exactly 3,600,000ms', () => {
    const { start, end } = statsRangeBounds('1h');
    expect(end).toBe(NOW_MS);
    expect(end! - start!).toBe(60 * 60 * 1000);
  });

  it('is a rolling hour rather than the current clock hour', () => {
    // Two minutes past the hour. A clock-hour implementation would report a
    // two-minute window under a label that promises sixty.
    const justPast = Date.UTC(2026, 7, 29, 10, 32, 0); // 14:02 in Tehran
    const { start, end } = statsRangeBounds('1h', justPast);
    expect(end! - start!).toBe(60 * 60 * 1000);
    expect(wall.format(end!)).toBe('14:02:00');
    expect(wall.format(start!)).toBe('13:02:00');
  });
});

describe('the month is the Jalali month, asked of the calendar', () => {
  it('starts on 1 Shahrivar and the instant before it is the previous month', () => {
    const { start, end } = statsRangeBounds('month');

    expect(jalaliParts(start!)).toMatchObject({ year: 1405, month: 6, day: 1 });
    expect(jalaliParts(start! - 1).month).toBe(5);
    expect(jalaliParts(end!).day).toBe(1);
    expect(wall.format(start!)).toBe('00:00:00');
  });

  it('is not the Gregorian month the legacy screen reported', () => {
    // The PHP used `new DateTime('first day of this month')`. On this instant
    // that is 1 September; the Jalali month began on 23 August. If these ever
    // coincide the assertion below is the thing that will say so.
    const { start } = statsRangeBounds('month');
    expect(gregorian.format(start!)).toBe('2026-08-23');
    expect(gregorian.format(start!)).not.toBe('2026-08-01');
  });

  it('the previous month ends exactly where this one begins', () => {
    const prev = statsRangeBounds('prev_month');
    const cur = statsRangeBounds('month');
    expect(prev.end).toBe(cur.start);
    expect(jalaliParts(prev.start!)).toMatchObject({ year: 1405, month: 5, day: 1 });
  });

  it('holds for 400 consecutive days, so no leap rule or month length hides', () => {
    for (let i = 0; i < 400; i++) {
      const at = NOW_MS + i * DAY_MS;
      const { start, end } = statsRangeBounds('month', at);

      // Day one of a month, at Tehran midnight, on both edges.
      expect(jalaliParts(start!).day, `start of month at day ${i}`).toBe(1);
      expect(jalaliParts(end!).day, `end of month at day ${i}`).toBe(1);
      expect(wall.format(start!), `midnight at day ${i}`).toBe('00:00:00');

      // The instant itself is inside the window it was asked about.
      expect(at, `containment at day ${i}`).toBeGreaterThanOrEqual(start!);
      expect(at, `containment at day ${i}`).toBeLessThan(end!);

      // Jalali months are 29–31 days. Anything else means the walk skipped one.
      const days = Math.round((end! - start!) / DAY_MS);
      expect(days, `month length at day ${i}`).toBeGreaterThanOrEqual(29);
      expect(days, `month length at day ${i}`).toBeLessThanOrEqual(31);

      // And the previous month abuts it with no gap and no overlap.
      expect(statsRangeBounds('prev_month', at).end, `abutment at day ${i}`).toBe(start);
    }
  });
});

describe('a custom window covers both days it names', () => {
  it('runs from the first day midnight to the LAST day midnight, inclusive', () => {
    // «از ۷ شهریور تا ۷ آبان» — 2026-08-29 to 2026-10-29.
    const { start, end } = statsRangeBounds('between', NOW_MS, '2026-08-29', '2026-10-29');

    expect(gregorian.format(start!)).toBe('2026-08-29');
    expect(wall.format(start!)).toBe('00:00:00');
    // The end is the *start of the day after* the last named day, so anything
    // that happened on 29 October is inside. Taking that day's own midnight
    // would silently drop it.
    expect(gregorian.format(end! - 1)).toBe('2026-10-29');
    expect(wall.format(end!)).toBe('00:00:00');
  });

  it('is the same window whichever way round the two dates are given', () => {
    const forward = statsRangeBounds('between', NOW_MS, '2026-08-29', '2026-10-29');
    const backward = statsRangeBounds('between', NOW_MS, '2026-10-29', '2026-08-29');
    expect(backward).toEqual(forward);
  });

  it('covers a single day when both ends name it', () => {
    const { start, end } = statsRangeBounds('between', NOW_MS, '2026-08-29', '2026-08-29');
    expect(end! - start!).toBe(DAY_MS);
    expect(statsRangeBounds('today', NOW_MS)).toEqual({ start, end });
  });

  it('falls back to today for a malformed edge rather than throwing', () => {
    const { start, end } = statsRangeBounds('between', NOW_MS, 'not-a-date', '2026-08-29');
    expect(end! - start!).toBe(DAY_MS);
  });
});

describe('parsing refuses to invent a range', () => {
  it('keeps every value the screen offers', () => {
    const known: StatsRange[] = [
      '1h',
      'today',
      'yesterday',
      'month',
      'prev_month',
      'day',
      'between',
    ];
    for (const r of known) expect(parseStatsRange(r)).toBe(r);
  });

  it('falls back to all for anything else', () => {
    for (const raw of ['all', '7d', '', null, undefined, 'MONTH', 'drop table']) {
      expect(parseStatsRange(raw)).toBe('all');
    }
  });

  it('all has no bounds at all, rather than very wide ones', () => {
    expect(statsRangeBounds('all')).toEqual({ start: null, end: null });
  });
});
