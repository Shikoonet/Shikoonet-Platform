/**
 * The finance hub's date ranges — one definition, read by both sides.
 *
 * ## Why this type moved here
 *
 * It was written twice: `packages/domain/src/historyRange.ts` for the server
 * and `apps/admin-web/src/hub/paymentReview.ts:75` for the panel, because
 * `admin-web` does not depend on `@shikoo/domain` and never should — the domain
 * package reaches Postgres. Two hand-kept copies of a union is a drift waiting
 * for its first divergence, and the divergence is silent in the worst possible
 * direction: the panel sends a `range` the server has never heard of,
 * `parseHistoryRange` falls through to its `default:` and answers `all`, and
 * the operator reads a whole-history figure under a one-month label.
 *
 * Both packages already depend on `@shikoo/contracts`, so this is where the
 * single copy belongs. The arithmetic stays in `@shikoo/domain` — only the
 * vocabulary is shared.
 *
 * ## Why the Jalali month is in this list and «یک ساعت اخیر» is not
 *
 * Sam asked to filter money by month — «مثلاً توی ماه مرداد». `StatsRange` in
 * the domain package already has that window, computed from `Intl` on the
 * Persian calendar, but it is a different union serving the shop's «آمار»
 * screen, and it lacks the rolling `7d`/`30d` this hub offers. Neither union
 * is a superset of the other.
 *
 * `statsRange.ts`'s own header argues against widening this one, and it is
 * right about the case it was written for: `1h` has no honest day count, and
 * `historyRangeDays` has to return one. A Jalali month is different — it is a
 * whole number of Tehran days, 29 to 31 of them. What it does not have is a
 * *fixed* count, which is why `historyRangeDays` answers `null` for it and
 * `historyRangeBounds` never asks.
 *
 * So the month is added and the hour is not. That is not a compromise: an
 * operator asking «چقدر در مرداد فروختیم» wants a calendar month, and an
 * operator watching a card go hot has the six rolling windows on the card
 * screen for that.
 */

/** Every window the hub's `range=` parameter accepts. */
export type HistoryRange =
  | 'all'
  | 'today'
  | '2d'
  | '3d'
  | '7d'
  | '30d'
  | 'month'
  | 'prev_month'
  | 'day';

/**
 * The subset the date control actually offers.
 *
 * Narrower than `HistoryRange` on purpose: `today`, `2d` and `3d` are still
 * accepted by the API — links and saved URLs use them — but the control does
 * not list them, because «روز انتخاب‌شده» already covers a single day and two
 * near-identical two-and-three-day buttons is a menu nobody reads.
 */
export type HistoryRangePreset = 'all' | '7d' | '30d' | 'month' | 'prev_month' | 'day';
