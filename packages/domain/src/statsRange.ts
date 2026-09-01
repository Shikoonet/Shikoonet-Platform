/**
 * The seven windows the «آمار» screen offers, as UTC millisecond bounds.
 *
 * ## Why this is not `HistoryRange`
 *
 * `historyRange.ts` already has `all | today | 2d | 3d | 7d | 30d | day`, and
 * three of those are exactly what this screen needs. Widening that union was
 * the first thing tried and it is the wrong move: seventeen files switch on
 * `HistoryRange`, and `historyRangeDays` — which the financial hub reads to
 * size its trend buckets — has to return a **day count**. There is no honest
 * number to return for «یک ساعت اخیر», so widening the union means either a
 * lie in that function or a `default:` in sixteen call sites that were written
 * before these values existed.
 *
 * So the type is separate and the **arithmetic is not**. Every boundary below
 * is computed by `tehranDayFromUtc` / `tehranDayBoundsFromDate` from that same
 * file. A second definition of «midnight in Tehran» is precisely the bug that
 * file's own header describes — it ran 07:00 to 07:00 for every day of every
 * month and no test noticed, because the tests only asked whether it agreed
 * with itself.
 *
 * ## The month is the Jalali month
 *
 * The legacy screen this replaces uses PHP's `new DateTime('first day of this
 * month')` (`legacy/mirzabot-php/admin.php:504`), which is the **Gregorian**
 * month in the server's timezone. An admin reading «ماه فعلی» in Persian means
 * شهریور, not September, and for most of any Jalali month the two windows do
 * not even overlap at the edges — so the figure under that label has been
 * answering a question nobody asked.
 *
 * The boundary here is therefore the Jalali month, and it is read from
 * `Intl` with the `persian` calendar rather than converted by hand. That is
 * the outside truth for this: a hand-rolled Jalali conversion is a second
 * implementation of a calendar with leap rules that repeat on a 33-year cycle,
 * and the one thing worse than no month button is one that is right for four
 * years.
 *
 * The screen labels this «ماه جاری». It read «ماه شمسی» until 2026-08-30, to
 * warn an admin comparing the two bots during the cutover that this window is
 * not the legacy's Gregorian one. Sam asked for the change and the reason had
 * expired anyway: nobody reads the two screens side by side any more, and the
 * label was answering a question about our implementation («which calendar?»)
 * where the operator was asking one about their shop («this month or last?»).
 * The window itself is unchanged — still the Jalali month, still read from
 * `Intl`. If a side-by-side comparison is ever needed again, the thing to
 * restore is a note on the screen, not a calendar name in a button.
 */

import { toJalali } from '@shikoo/contracts';
import { tehranDayBoundsFromDate, tehranDayFromUtc, tehranDateStringFromMs } from './historyRange.js';

export type StatsRange =
  | 'all'
  | '1h'
  | 'today'
  | 'yesterday'
  | 'month'
  | 'prev_month'
  | 'day'
  | 'between';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive start, exclusive end, in UTC epoch ms. `all` → both null. */
export interface StatsBounds {
  start: number | null;
  end: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseStatsRange(raw: string | null | undefined): StatsRange {
  switch (raw) {
    case '1h':
    case 'today':
    case 'yesterday':
    case 'month':
    case 'prev_month':
    case 'day':
    case 'between':
      return raw;
    default:
      return 'all';
  }
}

export function parseStatsDay(raw: string | null | undefined): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  return raw;
}

/**
 * The Jalali day-of-month for an instant, in Tehran.
 *
 * From `@shikoo/contracts`, which is also what the panel's date picker reads.
 * A month boundary the server computes one way and the screen labels another is
 * two calendars, and the disagreement would surface as an off-by-one day on a
 * money figure — the hardest kind to notice.
 */
function jalaliDayOfMonth(epochMs: number): number {
  return toJalali(epochMs).day;
}

/**
 * Tehran midnight on the first day of the Jalali month containing `epochMs`.
 *
 * Stepping back `day - 1` whole days from the *Tehran day start* — rather than
 * from the instant — is what makes this exact regardless of the time of day it
 * is called, and Jalali months are whole numbers of days so no month can be
 * missed by the walk.
 */
function jalaliMonthStart(epochMs: number): number {
  const dayStart = tehranDayFromUtc(epochMs).start;
  return tehranDayFromUtc(dayStart - (jalaliDayOfMonth(dayStart) - 1) * DAY_MS).start;
}

/**
 * The Jalali month bounds containing `epochMs`, and the one before it.
 *
 * The next month's start is found by walking forward far enough to be certainly
 * inside the following month and then asking `Intl` where that month begins.
 * Jalali months run 29 to 31 days, so +32 days clears the longest one; nothing
 * here assumes a length.
 */
function jalaliMonthBounds(epochMs: number): { start: number; end: number } {
  const start = jalaliMonthStart(epochMs);
  return { start, end: jalaliMonthStart(start + 32 * DAY_MS) };
}

export function statsRangeBounds(
  range: StatsRange,
  nowMs = Date.now(),
  day?: string | null,
  to?: string | null,
): StatsBounds {
  switch (range) {
    case 'all':
      return { start: null, end: null };
    case '1h':
      // A rolling hour, not the current clock hour. «یک ساعت اخیر» is what an
      // admin asks after doing something, and a clock hour answers «since 14:00»
      // — which at 14:02 is a two-minute window reported as an hour.
      return { start: nowMs - HOUR_MS, end: nowMs };
    case 'today':
      return tehranDayFromUtc(nowMs);
    case 'yesterday':
      return tehranDayFromUtc(tehranDayFromUtc(nowMs).start - DAY_MS);
    case 'month':
      return jalaliMonthBounds(nowMs);
    case 'prev_month':
      return jalaliMonthBounds(jalaliMonthStart(nowMs) - DAY_MS);
    case 'day':
      return tehranDayBoundsFromDate(parseStatsDay(day) ?? tehranDateStringFromMs(nowMs));
    case 'between': {
      // Both ends are **inclusive days**, because that is what «از ۷ شهریور تا
      // ۷ آبان» means to the person who typed it. Taking the second date's day
      // *start* as the end would silently drop everything that happened on the
      // last day named — the sort of off-by-one that only shows up as a figure
      // slightly too small, which nobody queries.
      const a = tehranDayBoundsFromDate(parseStatsDay(day) ?? tehranDateStringFromMs(nowMs));
      const b = tehranDayBoundsFromDate(parseStatsDay(to) ?? tehranDateStringFromMs(nowMs));
      // Reversed dates are a slip, not an attack. A range is a set and its ends
      // are unordered; refusing would answer a harmless mistake with an error
      // page, and clamping to one day would answer it with a wrong number.
      return a.start <= b.start
        ? { start: a.start, end: b.end }
        : { start: b.start, end: a.end };
    }
  }
}
