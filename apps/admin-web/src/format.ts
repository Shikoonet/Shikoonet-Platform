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

/** Jalali date and time, Tehran. Returns the raw value if it will not parse. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : TEHRAN.format(ms);
}

/** Jalali date only, Tehran. */
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : TEHRAN_DATE.format(ms);
}
