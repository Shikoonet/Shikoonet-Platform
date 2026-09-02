import { describe, expect, it } from 'vitest';
import {
  historyRangeBounds,
  historyRangeDays,
  parseHistoryRange,
  tehranDayFromUtc,
  tehranDayBoundsFromDate,
  tehranAdjacentDay,
} from '../src/historyRange.js';
import { previousHistoryRangeBounds } from '../src/financialAnalytics.js';

/**
 * The Jalali date of an instant, asked of `Intl` rather than of the code under
 * test.
 *
 * This is the whole point of these cases. A month helper checked against
 * another month helper proves the two agree and nothing else -- the exact
 * pattern that let a «today in Tehran» function run 07:00 to 07:00 for months
 * with a green suite. `en-u-ca-persian-nu-latn` because a Persian locale
 * returns digits `Number()` cannot read.
 */
const JALALI = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** The Gregorian date in Tehran -- the calendar the legacy screen used. */
const TEHRAN_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function jalali(ms: number): { year: number; month: number; day: number; clock: string } {
  const p = Object.fromEntries(JALALI.formatToParts(ms).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    clock: `${p.hour}:${p.minute}`,
  };
}

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

describe('the money hub can ask for a Jalali month', () => {
  // 12:30 Tehran on a day well inside a month, so nothing here sits on an edge
  // by accident. Pinned: every expectation below is checked against `Intl`, and
  // a live clock would mean the assertions and the code read different
  // instants.
  const NOW = Date.UTC(2026, 8, 2, 9, 0, 0);

  it('parses the two new values and still refuses anything else', () => {
    expect(parseHistoryRange('month')).toBe('month');
    expect(parseHistoryRange('prev_month')).toBe('prev_month');
    expect(parseHistoryRange('1h')).toBe('all');
    expect(parseHistoryRange('mordad')).toBe('all');
  });

  it('starts at Tehran midnight on the 1st, as the Persian calendar has it', () => {
    const { start, end } = historyRangeBounds('month', NOW);
    expect(jalali(start!)).toMatchObject({ day: 1, clock: '00:00' });
    // The instant before the window is the last day of the month before it.
    expect(jalali(start! - 1).month).toBe(jalali(start!).month === 1 ? 12 : jalali(start!).month - 1);
    // And the window ends where the next month starts, with no gap.
    expect(jalali(end!)).toMatchObject({ day: 1, clock: '00:00' });
    expect(jalali(end! - 1).month).toBe(jalali(start!).month);
  });

  it('is not the Gregorian month, which is what the legacy screen reported', () => {
    // PHP's `new DateTime('first day of this month')` would say 1 September
    // here; Shahrivar 1405 begins on 23 August. Read in Tehran, not in UTC --
    // Tehran midnight is 20:30 UTC the day before, so `toISOString()` would
    // name the 22nd and the assertion would be about the wrong calendar twice
    // over. Both halves are checked, because a test that only says «not
    // September» would still pass if the window were nonsense.
    const { start } = historyRangeBounds('month', NOW);
    expect(TEHRAN_DATE.format(start!)).toBe('2026-08-23');
    expect(TEHRAN_DATE.format(start!)).not.toBe('2026-09-01');
  });

  it('prev_month is the month before, and the two tile exactly', () => {
    const cur = historyRangeBounds('month', NOW);
    const prev = historyRangeBounds('prev_month', NOW);
    expect(prev.end).toBe(cur.start);
    expect(jalali(prev.start!)).toMatchObject({ day: 1, clock: '00:00' });
    expect(jalali(prev.start!).month).toBe(jalali(cur.start!).month - 1);
  });

  it('has no fixed day count, and says so rather than guessing one', () => {
    // Shahrivar is 31 days and Mehr is 30. A single number would be wrong for
    // one of them, which is why this answers null and `historyRangeBounds`
    // never asks.
    expect(historyRangeDays('month')).toBeNull();
    expect(historyRangeDays('prev_month')).toBeNull();
    const { start, end } = historyRangeBounds('month', NOW);
    expect((end! - start!) / (24 * 60 * 60 * 1000)).toBe(31);
  });

  /**
   * Asked from inside Mehr, and that is the whole test.
   *
   * `previousHistoryRangeBounds` subtracts the current window's span for every
   * other range. From Shahrivar -- 31 days, following 31-day Mordad -- that
   * subtraction lands exactly on the previous month, so the same assertion at
   * `NOW` passes with the month case deleted. It was written that way first and
   * seen to stay green with the guard removed: silent, not passing.
   *
   * Months 1-6 are 31 days and 7-11 are 30, so the first honest instant is in
   * Mehr: 30 days back from its start is one day *inside* Shahrivar, and the
   * «previous period» would straddle two months.
   */
  it('compares a month against the month before it, not against N days earlier', () => {
    const IN_MEHR = Date.UTC(2026, 9, 5, 9, 0, 0);
    expect(jalali(IN_MEHR).month).toBe(7);

    const prev = previousHistoryRangeBounds('month', IN_MEHR);
    const explicit = historyRangeBounds('prev_month', IN_MEHR);
    expect(prev.start).toBe(explicit.start);
    expect(prev.end).toBe(explicit.end);
    expect(jalali(prev.start!)).toMatchObject({ month: 6, day: 1, clock: '00:00' });

    // And the wrong answer is genuinely different here, so the equality above
    // carries weight rather than restating a coincidence. The buggy path
    // subtracts the CURRENT window's span -- Mehr's 30 days -- from Mehr's
    // start, which lands one day inside 31-day Shahrivar.
    const cur = historyRangeBounds('month', IN_MEHR);
    const bySpan = cur.start! - (cur.end! - cur.start!);
    expect(bySpan).not.toBe(explicit.start);
    expect(jalali(bySpan).day).toBe(2);
  });

  it('walks 400 days without a leap rule or a short month slipping through', () => {
    // More than one Jalali year, so 29-, 30- and 31-day months and an Esfand
    // all appear. Every month must begin on day 1 at Tehran midnight and tile
    // against the one before it.
    for (let i = 0; i < 400; i++) {
      const at = NOW + i * 24 * 60 * 60 * 1000;
      const cur = historyRangeBounds('month', at);
      const prev = historyRangeBounds('prev_month', at);
      expect(jalali(cur.start!)).toMatchObject({ day: 1, clock: '00:00' });
      expect(jalali(prev.start!)).toMatchObject({ day: 1, clock: '00:00' });
      expect(prev.end).toBe(cur.start);
      expect(cur.start! <= at && at < cur.end!).toBe(true);
      // The comparison period is the previous month on every one of these days,
      // including each 31-to-30 and 30-to-29 transition -- which is where
      // subtracting the span stops coinciding with it.
      expect(previousHistoryRangeBounds('month', at)).toEqual(prev);
    }
  });
});
