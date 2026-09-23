/**
 * «ماه، فصل یا سال» — every period's last day is followed, in the calendar, by
 * the next period's first. Checked against `Intl`'s Persian calendar (read
 * here directly), not against `jalaliMonthLength`, which the code uses.
 */

import { describe, expect, it } from 'vitest';
import { jalaliToEpochMs } from '@shikoo/contracts';
import { currentPeriod, periodDays, type PeriodKind } from '../src/PeriodPicker.js';

const persian = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});
/** The Persian date `ms` falls on, as Intl says it. */
function intlDay(ms: number) {
  const parts = Object.fromEntries(persian.formatToParts(ms).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const COUNT: Record<PeriodKind, number> = { month: 12, quarter: 4, half: 2, year: 1 };

describe('periodDays', () => {
  for (const kind of ['month', 'quarter', 'half', 'year'] as PeriodKind[]) {
    it(`${kind}: each one starts on the 1st and ends the day before the next begins (1403 is a leap year)`, () => {
      for (const year of [1403, 1404, 1405]) {
        for (let index = 1; index <= COUNT[kind]; index++) {
          const { from, to } = periodDays({ kind, year, index });
          expect(from.day).toBe(1);
          // Noon on the last day (`jalaliToEpochMs` is midday), plus a day.
          const next = intlDay(jalaliToEpochMs(to) + 86_400_000);
          const want = index < COUNT[kind] ? periodDays({ kind, year, index: index + 1 }).from : { year: year + 1, month: 1, day: 1 };
          expect(next).toEqual(want);
        }
      }
    });
  }

  it('Aban 1405 is in autumn and the second half', () => {
    const aban = Date.parse('2026-11-01T12:00:00+03:30'); // 10 Aban 1405
    expect(currentPeriod('quarter', aban)).toEqual({ kind: 'quarter', year: 1405, index: 3 });
    expect(currentPeriod('half', aban)).toEqual({ kind: 'half', year: 1405, index: 2 });
    expect(periodDays(currentPeriod('month', aban))).toEqual({
      from: { year: 1405, month: 8, day: 1 },
      to: { year: 1405, month: 8, day: 30 },
    });
  });
});
