/**
 * Numbers and dates, in the units and calendar the admin reads.
 *
 * Two conversions happen at this edge and nowhere else:
 *
 *   **IRR → Toman.** Everything the API sends is integer Rial, because that is
 *   what the database stores and what every money guarantee is written in.
 *   The admin and the customer both talk in Toman. The division lives here so
 *   there is exactly one place it can be wrong.
 *
 *   **UTC → Tehran.** Timestamps arrive as ISO strings in UTC. They are
 *   formatted with `Intl` against `Asia/Tehran` rather than the browser's own
 *   zone: an admin travelling, or a laptop with a wrong clock setting, must
 *   still see the same time the bot showed the customer.
 */

const FA = new Intl.NumberFormat('fa-IR');

/** Toman from Rial. Integer division — the schema never stores sub-Toman. */
export function irrToToman(irr: number): number {
  return Math.trunc(irr / 10);
}

/** "۱٬۲۳۴٬۵۶۷ تومان", with the sign kept for a debit. */
export function toman(irr: number | null | undefined): string {
  if (irr == null) return '—';
  return `${FA.format(irrToToman(irr))} تومان`;
}

/** Short form for the stat cards, where the full digits do not fit. */
export function tomanCompact(irr: number | null | undefined): string {
  if (irr == null) return '—';
  const t = irrToToman(irr);
  const abs = Math.abs(t);
  if (abs >= 1_000_000_000) return `${FA.format(Math.round(t / 100_000_000) / 10)} میلیارد ت`;
  if (abs >= 1_000_000) return `${FA.format(Math.round(t / 100_000) / 10)} میلیون ت`;
  if (abs >= 1_000) return `${FA.format(Math.round(t / 1_000))} هزار ت`;
  return `${FA.format(t)} ت`;
}

export function count(n: number | null | undefined): string {
  return n == null ? '—' : FA.format(n);
}

const TEHRAN = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const TEHRAN_DATE = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Seconds included, for the finance screens only.
 *
 * A payment claim carries two timestamps that can be a few seconds apart — when
 * the phone received the bank SMS and when the server ingested it — and the
 * five-minute auto-verify window is decided on their difference. Rounded to the
 * minute they look identical, which is exactly the case an operator is looking
 * at the screen to understand.
 */
const TEHRAN_SECONDS = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Epoch milliseconds as well as ISO strings.
 *
 * The panel's own API answers ISO; the finance screens, which came from the
 * payment hub, carry `bank_timestamp` and friends as numbers. One formatter
 * taking both is what let the second copy of this module be deleted — and the
 * second copy formatted in the browser's own zone, so an admin travelling saw a
 * different time than the bot had shown the customer.
 */
type Stamp = string | number | null | undefined;

function msOf(value: Stamp): number | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Jalali date and time, Tehran. Returns the raw value if it will not parse. */
export function dateTime(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN.format(ms);
}

/** Jalali date, time and seconds, Tehran. */
export function dateTimeSeconds(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN_SECONDS.format(ms);
}

/** Jalali date only, Tehran. */
export function dateOnly(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN_DATE.format(ms);
}

/**
 * The instant a code dated `YYYY-MM-DD` stops working.
 *
 * `<input type="date">` hands back a bare calendar date, and the column it ends
 * up in is a `timestamptz`. The bot refuses a code when `expires_at <= now`, so
 * the right instant is the START of the following Tehran day: a code «until 1
 * Shahrivar» then works for all of that day and stops at midnight. Taking the
 * date at face value would cut it short by a day, which is the kind of
 * off-by-one a customer notices and an admin cannot see.
 *
 * Built by asking `Intl` where Tehran's clock stands at that moment rather than
 * by adding a fixed offset. `packages/domain/src/historyRange.ts` keeps its own
 * `TEHRAN_OFFSET_MS`, and duplicating that number here would be a second
 * definition of the same fact — the failure this repository has already had
 * with two Toman formatters. It is not imported instead, because `@shikoo/domain`
 * is a server package and pulling it into the browser bundle to reach one
 * constant costs more than this function does.
 */
export function endOfTehranDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  // Midday UTC on the day AFTER, which is inside that Tehran day whatever the
  // offset is, then walked back to that day's midnight in Tehran.
  const noonNext = Date.UTC(y, m - 1, d + 1, 12, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(noonNext));
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = (at('hour') * 3600 + at('minute') * 60 + at('second')) * 1000;
  return new Date(noonNext - sinceMidnight).toISOString();
}

/** What one gigabyte is here, and everywhere else in this repo. */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Traffic consumed.
 *
 * Two different things are borrowed from two different places, and the first
 * version of this got that wrong in a way only the screen could show.
 *
 * **The rounding is the bot's.** `apps/bot/src/menu.ts` gives the customer one
 * decimal, and two below a tenth of a gigabyte — because "۰٫۰" reads as
 * "nothing" to somebody who has just started using a service. An operator
 * reading a support message that quotes the bot has to see the same figure.
 *
 * **The digits are the panel's.** The first version copied the bot's
 * `toLocaleString('en-US')` along with the rounding, so «مصرف» rendered
 * `0 گیگ` in Latin digits directly beside «حجم» rendering `۱۰ گیگ` in Persian —
 * two adjacent cells in one row disagreeing about what a number looks like.
 * Nothing in a test saw it; walking the deployed screen did. `FA` is what every
 * other number on this panel goes through.
 *
 * `FA.format` of a rounded number drops a trailing zero exactly as the bot's
 * `Number(shown)` does, so 3.0 GB is «۳ گیگ» in both and 3.5 is «۳٫۵».
 */
export function gigabytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const gb = bytes / BYTES_PER_GB;
  const places = gb > 0 && gb < 0.1 ? 2 : 1;
  return `${FA.format(Number(gb.toFixed(places)))} گیگ`;
}
