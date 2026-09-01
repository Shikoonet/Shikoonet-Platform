/**
 * The calendar, checked by round-tripping through `Intl` rather than against a
 * table this file wrote.
 *
 * `jalaliToEpochMs` is a search, so the only assertion worth making about it is
 * that **converting its answer forward lands back on the date asked for** — and
 * that it does so for every day of several years, not for the handful somebody
 * thought of. A Jalali leap rule that is wrong in 1408 is invisible to any test
 * that only looks at 1405.
 *
 * The two absolute dates below are the anchors that make the round trip mean
 * something. A round trip can be self-consistently wrong if both directions
 * share a bad offset; these say where the calendar actually is.
 */

import { describe, expect, it } from 'vitest';
import {
  JALALI_MONTHS,
  formatJalali,
  jalaliMonthLength,
  jalaliPeriodLabel,
  jalaliToEpochMs,
  jalaliToIsoDate,
  nextJalaliDue,
  toJalali,
} from '../src/jalali.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the calendar is where it actually is', () => {
  it('places Nowruz 1405 on 21 March 2026', () => {
    expect(jalaliToIsoDate({ year: 1405, month: 1, day: 1 })).toBe('2026-03-21');
  });

  it('reads 29 August 2026 as 7 Shahrivar 1405', () => {
    expect(toJalali(Date.UTC(2026, 7, 29, 8, 0, 0))).toEqual({ year: 1405, month: 6, day: 7 });
  });

  it('uses Tehran, not UTC, to decide which day an instant is on', () => {
    // 21:00 UTC is already 00:30 the next day in Tehran.
    const late = Date.UTC(2026, 7, 28, 21, 0, 0);
    expect(toJalali(late)).toEqual({ year: 1405, month: 6, day: 7 });
  });
});

describe('the inverse lands exactly where it was asked to', () => {
  it('round-trips every day of four consecutive years', () => {
    let checked = 0;
    for (let year = 1404; year <= 1407; year++) {
      for (let month = 1; month <= 12; month++) {
        const length = jalaliMonthLength(year, month);
        for (let day = 1; day <= length; day++) {
          expect(toJalali(jalaliToEpochMs({ year, month, day })), `${year}-${month}-${day}`).toEqual(
            { year, month, day },
          );
          checked++;
        }
      }
    }
    // Four years is between 1460 and 1462 days; a loop that silently did
    // nothing would pass every assertion above.
    expect(checked).toBeGreaterThan(1450);
  });

  it('produces consecutive instants for consecutive days', () => {
    // Across the Farvardin/Esfand boundary, where a converter that assumed a
    // fixed month length would jump.
    let previous = jalaliToEpochMs({ year: 1404, month: 12, day: 28 });
    for (const date of [
      { year: 1404, month: 12, day: 29 },
      { year: 1405, month: 1, day: 1 },
      { year: 1405, month: 1, day: 2 },
    ]) {
      const at = jalaliToEpochMs(date);
      expect(at - previous, `${date.year}-${date.month}-${date.day}`).toBe(DAY_MS);
      previous = at;
    }
  });

  it('refuses a date that does not exist rather than nudging it', () => {
    expect(() => jalaliToEpochMs({ year: 1405, month: 12, day: 31 })).toThrow(/no such Jalali/);
    expect(() => jalaliToEpochMs({ year: 1405, month: 7, day: 31 })).toThrow(/no such Jalali/);
  });
});

describe('month lengths come from the calendar, not from a rule', () => {
  it('gives 31 to the first six months and 30 to the next five', () => {
    for (let month = 1; month <= 6; month++) expect(jalaliMonthLength(1405, month)).toBe(31);
    for (let month = 7; month <= 11; month++) expect(jalaliMonthLength(1405, month)).toBe(30);
  });

  it('gives Esfand 29 or 30, and finds at least one of each across a cycle', () => {
    const lengths = new Set<number>();
    for (let year = 1400; year <= 1420; year++) {
      const n = jalaliMonthLength(year, 12);
      expect(n, `Esfand ${year}`).toBeGreaterThanOrEqual(29);
      expect(n, `Esfand ${year}`).toBeLessThanOrEqual(30);
      lengths.add(n);
    }
    // If this ever holds only one value, the leap rule stopped being consulted.
    expect(lengths).toEqual(new Set([29, 30]));
  });

  it('has twelve month names in calendar order', () => {
    expect(JALALI_MONTHS).toHaveLength(12);
    expect(JALALI_MONTHS[0]).toBe('فروردین');
    expect(JALALI_MONTHS[11]).toBe('اسفند');
  });
});

/**
 * Billing periods, which is the whole reason a recurring expense can say when
 * it is next owed.
 *
 * Checked by converting the answer BACK through `Intl` rather than against
 * dates written here: an expectation like «2026-10-22» would be this file
 * agreeing with itself about a Gregorian conversion, which is the shape of
 * self-consistent test CLAUDE.md rule 6 is about. What is asserted is the
 * calendar property — same day-of-month one month on, or the last day of that
 * month when there is no such day.
 */
describe('the next billing date', () => {
  /** The Jalali date an ISO day lands on, asked of Intl and not of us. */
  const jalaliOf = (iso: string) => toJalali(Date.parse(`${iso}T12:00:00Z`));

  it('keeps the day of the month, one Jalali month on', () => {
    // Every day of a whole year, so a month with 29, 30 or 31 days is covered
    // without anybody having to remember which is which.
    for (let month = 1; month <= 12; month++) {
      for (let day = 1; day <= jalaliMonthLength(1405, month); day++) {
        const from = jalaliToIsoDate({ year: 1405, month, day });
        const to = jalaliOf(nextJalaliDue(from, 'MONTHLY'));

        const expectedYear = month === 12 ? 1406 : 1405;
        const expectedMonth = month === 12 ? 1 : month + 1;
        expect(to.year).toBe(expectedYear);
        expect(to.month).toBe(expectedMonth);
        // The same day, unless that month is too short to have one.
        expect(to.day).toBe(Math.min(day, jalaliMonthLength(expectedYear, expectedMonth)));
      }
    }
  });

  it('clamps to the last day when the next month is shorter', () => {
    // Shahrivar has 31 days and Mehr has 30, so 31 Shahrivar has nowhere to
    // land. `+ interval '1 month'` in Postgres would answer with a Gregorian
    // month here and be wrong twice over.
    expect(jalaliMonthLength(1405, 6)).toBe(31);
    expect(jalaliMonthLength(1405, 7)).toBe(30);

    const from = jalaliToIsoDate({ year: 1405, month: 6, day: 31 });
    expect(jalaliOf(nextJalaliDue(from, 'MONTHLY'))).toEqual({ year: 1405, month: 7, day: 30 });
  });

  it('advances a year for a yearly period, landing on the same Jalali day', () => {
    const from = jalaliToIsoDate({ year: 1405, month: 6, day: 8 });
    expect(jalaliOf(nextJalaliDue(from, 'YEARLY'))).toEqual({ year: 1406, month: 6, day: 8 });
  });

  it('advances exactly one period from a date already in the past', () => {
    // A template three months overdue is three charges, posted one at a time.
    // Catching up in a single jump would lose two rows nobody could rebuild.
    const from = jalaliToIsoDate({ year: 1405, month: 3, day: 10 });
    expect(jalaliOf(nextJalaliDue(from, 'MONTHLY'))).toEqual({ year: 1405, month: 4, day: 10 });
  });

  it('names the month a day falls in, for the note on a posted instalment', () => {
    expect(jalaliPeriodLabel(jalaliToIsoDate({ year: 1405, month: 6, day: 8 }))).toBe('شهریور ۱۴۰۵');
    expect(jalaliPeriodLabel(jalaliToIsoDate({ year: 1405, month: 12, day: 1 }))).toBe('اسفند ۱۴۰۵');
    // Ungrouped: «۱٬۴۰۵» is not a year, and `fa-IR` groups by default.
    expect(jalaliPeriodLabel(jalaliToIsoDate({ year: 1405, month: 1, day: 1 }))).not.toContain('٬');
  });
});

describe('display', () => {
  it('names the Persian calendar rather than trusting the locale default', () => {
    const at = Date.UTC(2026, 7, 29, 8, 0, 0);
    expect(formatJalali(at)).toContain('۱۴۰۵');
    expect(formatJalali(at)).toContain('شهریور');
    expect(formatJalali(at, true)).toMatch(/۱۱:۳۰/);
  });
});
