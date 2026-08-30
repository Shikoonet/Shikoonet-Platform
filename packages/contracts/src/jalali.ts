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

const YEAR_FA = new Intl.NumberFormat('fa-IR', { useGrouping: false });

/**
 * A Jalali date one billing period on, as `YYYY-MM-DD`.
 *
 * `jalaliMonthLength` rather than `+ 1 month` in SQL or `+ 30 days` anywhere:
 * Jalali months are 29 to 31 days on a 33-year leap cycle, so a bill due
 * 31 Mordad has no 31st to land on in Aban, and Postgres would answer with a
 * Gregorian month regardless. The day is clamped to the last of the target
 * month, which is what every billing system does with the same problem.
 *
 * Advances by exactly ONE period, even from a date months in the past. A
 * template three months overdue is three separate charges an operator posts one
 * at a time — collapsing them into one advance would lose two rows nobody could
 * reconstruct.
 */
export function nextJalaliDue(isoDay: string, period: 'MONTHLY' | 'YEARLY'): string {
  // Midday, so a date-only string cannot slip into the previous day in Tehran.
  const at = toJalali(Date.parse(`${isoDay}T12:00:00Z`));
  const year = period === 'YEARLY' ? at.year + 1 : at.month === 12 ? at.year + 1 : at.year;
  const month = period === 'YEARLY' ? at.month : at.month === 12 ? 1 : at.month + 1;
  return jalaliToIsoDate({ year, month, day: Math.min(at.day, jalaliMonthLength(year, month)) });
}

/**
 * Which Jalali month a day falls in, named — «شهریور 1405».
 *
 * Shared rather than written twice because the panel prefills a recurring
 * charge's description with it and the server produces the same string when the
 * panel sends none. Two copies of that rule would drift the first time one of
 * them was reworded, and the drift would show up as two differently-named rows
 * for the same monthly bill.
 *
 * Persian digits, ungrouped. This was Latin until it was read on the screen
 * next to «۱۴۰۵/۰۶/۰۱» and looked like a bug — every other number on that panel
 * is Persian, including the one an operator would copy in order to search for
 * this row. Grouping is off because «۱٬۴۰۵» is not a year.
 */
export function jalaliPeriodLabel(isoDay: string): string {
  const at = toJalali(Date.parse(`${isoDay}T12:00:00Z`));
  return `${JALALI_MONTHS[at.month - 1]} ${YEAR_FA.format(at.year)}`;
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
