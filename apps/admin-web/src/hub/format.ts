/**
 * The finance screens' names for the panel's formatters.
 *
 * This file used to be the second money-and-dates module in the package: Latin
 * digits, the word «Toman» in English, `Math.floor` where the other used
 * `Math.trunc`, and timestamps in whichever zone the laptop happened to be
 * set to. Under a right-to-left layout the English suffix also landed on the
 * wrong side — «Toman 12,605» — which is what finally made it visible.
 *
 * Everything now goes through `../format.js`, which has one division, one
 * calendar and one timezone. What is left here is the vocabulary these screens
 * already call things by: renaming thirty call sites would be a bigger diff
 * than this file, and would change no output.
 *
 * `Math.trunc` won over `Math.floor`, which they disagreed on for negative
 * amounts (`-15` Rial was −1 Toman one way and −2 the other). The schema stores
 * integer Rial and the shop has no sub-Toman price, so no displayed number
 * moves — but one of the two had to be the answer, and the panel's is the one
 * with a test against `Intl` behind it.
 */

import { count, dateTime, dateTimeSeconds, irrToToman, toman, tomanCompact } from '../format.js';

export { irrToToman };

/** A value already in Toman. */
export function formatToman(value: number | null | undefined): string {
  return value == null ? '—' : `${count(value)} تومان`;
}

/** An IRR-stored amount, shown in Toman. */
export function formatTomanFromIrr(irr: number | null | undefined): string {
  return toman(irr);
}

/** Compact Toman for the stat cards, where the full digits do not fit. */
export function formatCompactTomanFromIrr(value: number | null | undefined): string {
  return value == null ? 'موجودی در دسترس نیست' : tomanCompact(value);
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
  return dateTime(ts);
}

/**
 * Like formatTime but always includes seconds, so two SMS timestamps seconds
 * apart — phone receipt versus server ingestion — can be told apart. The
 * five-minute auto-verify window is decided on that difference.
 */
export function formatTimeSeconds(ts: number): string {
  return dateTimeSeconds(ts);
}

export function directionLabel(d: 'CREDIT' | 'DEBIT' | 'UNKNOWN'): string {
  // Credit-only product: DEBIT and UNKNOWN are filtered out by the route layer
  // and are not expected on screen, but a legacy row that leaks through is
  // labelled plainly rather than silently shown as an ordinary deposit.
  return d === 'CREDIT' ? 'واریز' : d === 'DEBIT' ? 'برداشت (نمایش داده نمی‌شود)' : 'نامشخص';
}

export function statusLabel(s: string): string {
  switch (s) {
    case 'PARSED':
      return 'پردازش شد';
    case 'NEEDS_REVIEW':
      return 'نیاز به بررسی';
    case 'APPROVED':
      return 'تایید شد';
    case 'SUGGESTED':
      return 'پیشنهاد شد';
    case 'CONFIRMED':
      return 'تایید';
    case 'REJECTED':
      return 'رد شد';
    case 'VERIFIED':
      return 'تاییدشده';
    case 'PENDING':
      return 'در انتظار';
    case 'FAKE_RECEIPT':
      return 'رسید جعلی';
    default:
      return s;
  }
}
