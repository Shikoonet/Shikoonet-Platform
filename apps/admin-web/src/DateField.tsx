/**
 * A Jalali date, picked the way a Persian date is spoken.
 *
 * Lifted out of `StatsPage.tsx` on 2026-08-30, unchanged, when «هزینه‌ها» grew
 * a spend-date filter and needed exactly the same control. It sits at the top
 * level beside `CopyButton.tsx` rather than in a `components/` directory,
 * because there is no such directory and inventing one for the second shared
 * component is scaffolding.
 *
 * Its own test is the browser: `e2e/stats.spec.ts` drives this picker on the
 * stats screen, so a move that broke it would fail there. A new unit test for
 * a pure move would only assert that a copy is a copy.
 */

import { JALALI_MONTHS, jalaliMonthLength, toJalali, type JalaliDate } from '@shikoo/contracts';

/**
 * One Jalali date: day, month, year.
 *
 * Three selects rather than a calendar widget, and rather than the browser's
 * `<input type="date">` — that one renders a Gregorian picker whatever the page
 * language is, so choosing «۷ شهریور» meant hunting for 29 August. Selects need
 * no dependency, work on a phone, and cannot offer a date that does not exist:
 * the day list is the month's real length, asked of the calendar rather than
 * assumed.
 *
 * **The DOM order is the reading order.** The page is RTL, so day first in the
 * markup puts day furthest right — ۷ | شهریور | ۱۴۰۵, the order the date is
 * spoken in Persian. Writing year-first put the year under the reader's thumb
 * and read backwards.
 */
export function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: JalaliDate;
  onChange: (d: JalaliDate) => void;
}) {
  const today = toJalali(Date.now());
  const years = [today.year - 3, today.year - 2, today.year - 1, today.year];
  const length = jalaliMonthLength(value.year, value.month);

  /**
   * Clamped, because 31 Farvardin exists and 31 Mehr does not.
   *
   * Without this, picking 31 Farvardin and then switching to Mehr asks for a
   * date the calendar has no answer for, and `jalaliToEpochMs` throws rather
   * than guessing — correctly, but on a screen the operator is looking at.
   */
  const move = (next: Partial<JalaliDate>) => {
    const merged = { ...value, ...next };
    onChange({ ...merged, day: Math.min(merged.day, jalaliMonthLength(merged.year, merged.month)) });
  };

  return (
    <div className="datefield">
      <span className="datefield__label">{label}</span>
      <div className="datefield__row">
        <select
          className="form-control"
          data-part="day"
          aria-label={`روز ${label}`}
          value={value.day}
          onChange={(e) => move({ day: Number(e.target.value) })}
        >
          {Array.from({ length }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d.toLocaleString('fa-IR')}
            </option>
          ))}
        </select>
        <select
          className="form-control"
          data-part="month"
          aria-label={`ماه ${label}`}
          value={value.month}
          onChange={(e) => move({ month: Number(e.target.value) })}
        >
          {JALALI_MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="form-control"
          data-part="year"
          aria-label={`سال ${label}`}
          value={value.year}
          onChange={(e) => move({ year: Number(e.target.value) })}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y.toLocaleString('fa-IR', { useGrouping: false })}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
