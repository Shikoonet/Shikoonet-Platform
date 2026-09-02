/**
 * The rolling windows the card screen shows side by side.
 *
 * ## Why six columns and not six buttons
 *
 * Sam asked for «تعداد تراکنش هر کارت در ۱۲ ساعت، ۲۴ ساعت، ۳ روز، ۷ روز،
 * ۱۵ روز و ۱ ماه». Those are not six views of one number, they are one row:
 * whether a card is warming up or going quiet is a *shape* across the windows,
 * and a picker would make an operator click six times and hold the shape in
 * their head. Six columns, one glance.
 *
 * ## Rolling, not calendar
 *
 * «۲۴ ساعت» is the last twenty-four hours, not «امروز». Today is a Tehran
 * calendar day, so at 01:00 it is a one-hour window reported under a day's
 * name — the same trap `statsRange.ts` documents for «یک ساعت اخیر». Nothing
 * here touches a calendar, so nothing here needs a timezone.
 *
 * ## The last one is 30 days, and it says so
 *
 * Sam said «۱ ماه». The screen next to this one can filter by the *Jalali*
 * month, which is a different window of a different length, and two meanings
 * of «ماه» on adjacent screens would be two different numbers under one word.
 * This one is labelled «۳۰ روز» for that reason.
 *
 * Shared rather than written on both sides: the server derives the cut-offs
 * and the panel draws the headers, and a seventh window added to one copy
 * would be a column of nulls in the other.
 */

export const CARD_ACTIVITY_WINDOWS = [
  { key: 'h12', hours: 12, label: '۱۲ ساعت' },
  { key: 'h24', hours: 24, label: '۲۴ ساعت' },
  { key: 'd3', hours: 24 * 3, label: '۳ روز' },
  { key: 'd7', hours: 24 * 7, label: '۷ روز' },
  { key: 'd15', hours: 24 * 15, label: '۱۵ روز' },
  { key: 'd30', hours: 24 * 30, label: '۳۰ روز' },
] as const;

/**
 * Derived from the list rather than declared beside it.
 *
 * An interface with `key: string` would widen the keys the moment the array
 * was typed as one, and then `counts[window.key]` stops type-checking — which
 * is exactly the indexing the panel does. Reading the type off the data keeps
 * the six keys literal all the way to the render.
 */
export type CardActivityWindow = (typeof CARD_ACTIVITY_WINDOWS)[number];

export type CardActivityWindowKey = CardActivityWindow['key'];

/** Counts per window, keyed as above. Every key is always present. */
export type CardActivityCounts = Record<CardActivityWindowKey, number>;
