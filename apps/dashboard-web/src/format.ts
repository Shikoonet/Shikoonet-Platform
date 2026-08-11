/**
 * Display formatting for financial amounts.
 * Amounts are stored in IRR (Rial) internally; the dashboard shows Toman (÷10).
 */

const numberFormatter = new Intl.NumberFormat('en-US');

/** Toman from IRR — explicit ÷10 (Mirzabot / customer-facing unit). */
export function irrToToman(irr: number): number {
  return Math.floor(irr / 10);
}

/** Format a value already in Toman for display. */
export function formatToman(toman: number | null | undefined): string {
  if (toman == null) return '—';
  return `${numberFormatter.format(toman)} Toman`;
}

/** Format an IRR-stored amount as Toman for display. */
export function formatTomanFromIrr(irr: number | null | undefined): string {
  if (irr == null) return '—';
  return formatToman(irrToToman(irr));
}

/** Compact Toman display for metrics (from IRR). */
export function formatCompactTomanFromIrr(value: number | null | undefined): string {
  if (value == null) return 'Balance unavailable';
  const toman = irrToToman(value);
  if (toman >= 1_000_000) return `${(toman / 1_000_000).toFixed(1)}M Toman`;
  if (toman >= 1_000) return `${Math.round(toman / 1_000)}K Toman`;
  return `${numberFormatter.format(toman)} Toman`;
}

/** @deprecated Use formatTomanFromIrr — kept for any legacy references. */
export function formatIrr(value: number | null | undefined): string {
  return formatTomanFromIrr(value);
}

/** @deprecated Use formatTomanFromIrr. */
export function formatIrrAndToman(value: number | null | undefined): string {
  return formatTomanFromIrr(value);
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * Like formatTime but always includes seconds, so two SMS timestamps
 * seconds apart (phone receipt vs server ingestion) can be distinguished
 * at a glance. Uses the runtime's locale + timezone.
 */
export function formatTimeSeconds(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Match the dashboard's existing default-locale format ("5 Aug 2026, 22:48:13")
  // by composing Intl.DateTimeFormat pieces.
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  return `${date}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function directionLabel(d: 'CREDIT' | 'DEBIT' | 'UNKNOWN'): string {
  // Credit-only product: CREDIT is shown as "واریز / Deposit"; DEBIT and
  // UNKNOWN are not surfaced in the default dashboard views (the route
  // layer filters them out), but if a legacy row leaks through we render
  // a clearly-marked label so the operator knows it's an excluded row.
  return d === 'CREDIT'
    ? 'واریز / Deposit'
    : d === 'DEBIT'
      ? 'برداشت (نمایش داده نمی‌شود)'
      : 'نامشخص';
}

export function statusLabel(s: string): string {
  switch (s) {
    case 'PARSED':
      return 'پردازش شد';
    case 'NEEDS_REVIEW':
      return 'نیاز به بررسی';
    case 'APPROVED':
      return 'تأیید شد';
    case 'SUGGESTED':
      return 'پیشنهاد شد';
    case 'CONFIRMED':
      return 'تأیید';
    case 'REJECTED':
      return 'رد شد';
    case 'VERIFIED':
      return 'راستی‌آزمایی';
    case 'PENDING':
      return 'در انتظار';
    case 'FAKE_RECEIPT':
      return 'رسید جعلی';
    default:
      return s;
  }
}
