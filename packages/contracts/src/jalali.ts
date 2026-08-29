/**
 * The Jalali calendar, for screens whose readers think in it.
 *
 * ## Why `Intl` and not a conversion table
 *
 * Jalali leap years follow a 33-year cycle whose exceptions are not expressible
 * as «every fourth year». Hand-rolled converters are usually right for the
 * decade they were tested in and quietly wrong afterwards, and the failure looks
 * like an off-by-one day on a report rather than like a crash — which is the
 * worst kind of wrong for a screen an admin uses to check money.
 *
 * So the platform's own calendar data is the authority. `toJalali` is a thin
 * read of `Intl`, and the inverse below is a **search that ends by asking
 * `Intl`** rather than a formula that claims to know the answer: it guesses a
 * day, converts it forward, and corrects until the forward conversion agrees.
 * An approximation that is checked is not an approximation.
 *
 * Everything here is Tehran wall-clock. A Jalali date is a *day*, and which day
 * an instant falls on depends on the zone you ask from.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `nu-latn` matters: a Persian locale returns digits `Number()` cannot read. */
const JALALI = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const GREGORIAN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface JalaliDate {
  year: number;
  month: number;
  day: number;
}

export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;

/** The Jalali date an instant falls on, in Tehran. */
export function toJalali(epochMs: number): JalaliDate {
  const p = Object.fromEntries(JALALI.formatToParts(epochMs).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Intl returned an unusable Jalali date for ${epochMs}`);
  }
  return { year, month, day };
}

/**
 * A monotonic day number that is *close* to the truth and never has to be exact.
 *
 * Months 1–6 have 31 days and 7–11 have 30, so this is right within a day or
 * two for any date; the leap rule it ignores is what the correction loop in
 * `jalaliToEpochMs` exists to absorb. It only has to be **monotonic**, so that
 * the difference between two of these points the search in the right direction.
 */
function approxDayNumber(d: JalaliDate): number {
  const beforeThisMonth = d.month <= 7 ? (d.month - 1) * 31 : 6 * 31 + (d.month - 7) * 30;
  return Math.round(d.year * 365.2422) + beforeThisMonth + d.day;
}

/** Noon Tehran on 7 Shahrivar 1405 = 29 August 2026, the search's starting point. */
const ANCHOR: JalaliDate = { year: 1405, month: 6, day: 7 };
const ANCHOR_MS = Date.UTC(2026, 7, 29, 8, 30, 0);

/**
 * Midday Tehran on a Jalali date — the inverse of `toJalali`.
 *
 * Midday rather than midnight on purpose: it is the instant furthest from both
 * edges of the day, so nothing here can be pushed into a neighbouring date by
 * an offset. Callers that want the day's boundary should take this instant and
 * ask for the Tehran day containing it.
 *
 * Throws rather than returning an approximate answer. A date this cannot land
 * on exactly is a date that does not exist — 31 Esfand, say — and answering
 * with «the nearest day» would put a report on a day nobody asked for.
 */
export function jalaliToEpochMs(date: JalaliDate): number {
  let ms = ANCHOR_MS + (approxDayNumber(date) - approxDayNumber(ANCHOR)) * DAY_MS;

  // Converges in one or two passes; the bound is a refusal, not a budget.
  for (let i = 0; i < 8; i++) {
    const at = toJalali(ms);
    if (at.year === date.year && at.month === date.month && at.day === date.day) return ms;

    const step = approxDayNumber(date) - approxDayNumber(at);
    if (step === 0) break; // the guess stopped improving — fall through to the scan
    ms += step * DAY_MS;
  }

  // Last resort: the guess is within a couple of days but the approximation has
  // stalled. Walk the neighbourhood, which is cheap and cannot loop.
  for (let offset = -3; offset <= 3; offset++) {
    const at = toJalali(ms + offset * DAY_MS);
    if (at.year === date.year && at.month === date.month && at.day === date.day) {
      return ms + offset * DAY_MS;
    }
  }

  throw new Error(`no such Jalali date: ${date.year}-${date.month}-${date.day}`);
}

/** `YYYY-MM-DD` in the Gregorian calendar — what the API's `day` parameter takes. */
export function jalaliToIsoDate(date: JalaliDate): string {
  return GREGORIAN.format(jalaliToEpochMs(date));
}

/** How many days a Jalali month has — 29, 30 or 31, asked rather than assumed. */
export function jalaliMonthLength(year: number, month: number): number {
  const start = jalaliToEpochMs({ year, month, day: 1 });
  const next =
    month === 12
      ? jalaliToEpochMs({ year: year + 1, month: 1, day: 1 })
      : jalaliToEpochMs({ year, month: month + 1, day: 1 });
  return Math.round((next - start) / DAY_MS);
}

/**
 * A Jalali date for display, from an instant.
 *
 * The calendar is named explicitly rather than left to `fa-IR`'s default.
 * Today those agree; a locale-data update that changed it would move every date
 * on the screen with nothing in the code recording that Jalali was the
 * intention.
 */
export function formatJalali(epochMs: number, withTime = false): string {
  return new Date(epochMs).toLocaleString(
    'fa-IR-u-ca-persian',
    withTime
      ? { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }
      : { timeZone: 'Asia/Tehran', dateStyle: 'medium' },
  );
}
