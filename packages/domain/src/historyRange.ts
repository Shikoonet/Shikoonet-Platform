/** Asia/Tehran history ranges for financial summaries (UTC+3:30, no DST). */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HistoryRange = 'all' | 'today' | '2d' | '3d' | '7d' | '30d' | 'day';

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
    raw === 'day'
  ) {
    return raw;
  }
  return 'all';
}

export function parseHistoryDay(raw: string | null | undefined): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  return raw;
}

export function historyRangeDays(range: HistoryRange): number | null {
  switch (range) {
    case 'all':
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
  const { start: todayStart, end: todayEnd } = tehranDayFromUtc(nowMs);
  const days = historyRangeDays(range)!;
  return { start: todayStart - (days - 1) * DAY_MS, end: todayEnd };
}
