/** Asia/Tehran history ranges for financial summaries (UTC+3:30, no DST). */
import { toJalali, type HistoryRange } from '@shikoo/contracts';

const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Re-exported so the seventeen files that import the type from here keep
// working; `@shikoo/contracts` holds the one definition. See its header.
export type { HistoryRange };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Tehran calendar day containing `epochMs`, as a UTC millisecond range.
 *
 * Shift the instant into Tehran wall-clock space, truncate to midnight there,
 * then shift back. Both steps are required: truncating first and adding the
 * offset afterwards gives the UTC day's midnight moved forward, which is a
 * different 24 hours entirely.
 *
 * That was the previous behaviour, and it was wrong for every instant of every
 * day — the window ran 07:00 Tehran to 07:00 Tehran instead of midnight to
 * midnight. Nothing caught it because the tests only checked that this function
 * agreed with itself. See BUGS-FOR-ADMIN.md item 7.
 */
export function tehranDayFromUtc(epochMs: number): { start: number; end: number } {
  const shifted = new Date(epochMs + TEHRAN_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  const start = shifted.getTime() - TEHRAN_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

/** Bounds for a Tehran calendar date (YYYY-MM-DD). */
export function tehranDayBoundsFromDate(dateStr: string): { start: number; end: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return tehranDayFromUtc(Date.UTC(y!, m! - 1, d!, 12, 0, 0, 0));
}

/** Tehran calendar date (YYYY-MM-DD) for an instant. */
export function tehranDateStringFromMs(epochMs: number): string {
  const tehranMs = epochMs + TEHRAN_OFFSET_MS;
  const d = new Date(tehranMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function tehranTodayDateString(nowMs = Date.now()): string {
  return tehranDateStringFromMs(nowMs);
}

export function tehranAdjacentDay(dateStr: string, deltaDays: number): string {
  const { start } = tehranDayBoundsFromDate(dateStr);
  return tehranDateStringFromMs(start + deltaDays * DAY_MS);
}

export function formatTehranDateLabel(dateStr: string): string {
  const { start } = tehranDayBoundsFromDate(dateStr);
  return new Date(start + 12 * 60 * 60 * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Tehran',
  });
}

export function tehranDayRelativeLabel(dateStr: string, nowMs = Date.now()): string | null {
  const today = tehranTodayDateString(nowMs);
  if (dateStr === today) return 'Today';
  if (dateStr === tehranAdjacentDay(today, -1)) return 'Yesterday';
  if (dateStr === tehranAdjacentDay(today, 1)) return 'Tomorrow';
  return null;
}

export function parseHistoryRange(raw: string | null | undefined): HistoryRange {
  if (
    raw === 'today' ||
    raw === '2d' ||
    raw === '3d' ||
    raw === '7d' ||
    raw === '30d' ||
    raw === 'month' ||
    raw === 'prev_month' ||
    raw === 'day'
  ) {
    return raw;
  }
  return 'all';
}

/**
 * Tehran midnight on the first day of the Jalali month containing `epochMs`.
 *
 * Lived in `statsRange.ts` until the money hub needed the same month. Two
 * copies of «where does Mordad begin» is exactly the shape of the bug this
 * file's own header describes — a boundary that was seven hours out for every
 * day of every month, green the whole time because the tests only asked
 * whether it agreed with itself.
 *
 * Stepping back `day - 1` whole days from the *Tehran day start* rather than
 * from the instant is what makes it exact regardless of the time of day it is
 * called, and Jalali months are whole numbers of days so the walk cannot miss
 * one. The day-of-month comes from `Intl`, never from a hand-rolled
 * conversion: the leap rule repeats on a 33-year cycle and a converter that is
 * right for four years is worse than no month button at all.
 */
export function jalaliMonthStart(epochMs: number): number {
  const dayStart = tehranDayFromUtc(epochMs).start;
  return tehranDayFromUtc(dayStart - (toJalali(dayStart).day - 1) * DAY_MS).start;
}

/**
 * The Jalali month containing `epochMs`, as UTC millisecond bounds.
 *
 * The next month's start is found by walking far enough forward to be
 * certainly inside the following month and then asking `Intl` where that month
 * begins. Jalali months run 29 to 31 days, so +32 clears the longest; nothing
 * here assumes a length.
 */
export function jalaliMonthBounds(epochMs: number): { start: number; end: number } {
  const start = jalaliMonthStart(epochMs);
  return { start, end: jalaliMonthStart(start + 32 * DAY_MS) };
}

export function parseHistoryDay(raw: string | null | undefined): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  return raw;
}

/**
 * How many days a range spans, or `null` when that is not a fixed number.
 *
 * `null` means «ask `historyRangeBounds`», not «all time». Two ranges answer it
 * and for different reasons: `all` has no start, and a Jalali month has 29, 30
 * or 31 days depending on which month of which year it is. Only
 * `historyRangeBounds` calls this, and it handles both before it gets here.
 */
export function historyRangeDays(range: HistoryRange): number | null {
  switch (range) {
    case 'all':
    case 'month':
    case 'prev_month':
      return null;
    case 'today':
    case 'day':
      return 1;
    case '2d':
      return 2;
    case '3d':
      return 3;
    case '7d':
      return 7;
    case '30d':
      return 30;
  }
}

/** Inclusive start, exclusive end in UTC epoch ms. `all` → null bounds. */
export function historyRangeBounds(
  range: HistoryRange,
  nowMs = Date.now(),
  day?: string | null,
): {
  start: number | null;
  end: number | null;
} {
  if (range === 'all') return { start: null, end: null };
  if (range === 'day') {
    const dateStr = parseHistoryDay(day) ?? tehranTodayDateString(nowMs);
    return tehranDayBoundsFromDate(dateStr);
  }
  if (range === 'month') return jalaliMonthBounds(nowMs);
  // One day back from this month's first instant is inside the previous month,
  // whatever its length. Nothing here assumes 30.
  if (range === 'prev_month') return jalaliMonthBounds(jalaliMonthStart(nowMs) - DAY_MS);
  const { start: todayStart, end: todayEnd } = tehranDayFromUtc(nowMs);
  const days = historyRangeDays(range)!;
  return { start: todayStart - (days - 1) * DAY_MS, end: todayEnd };
}
