const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalize Iranian payment card input to exactly 16 ASCII digits, or null. */
export function normalizeCardDigits(input: string): string | null {
  let s = input.trim();
  for (let i = 0; i < 10; i++) {
    s = s.replaceAll(PERSIAN_DIGITS[i]!, String(i));
    s = s.replaceAll(ARABIC_DIGITS[i]!, String(i));
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 16) return null;
  return digits;
}

/**
 * Luhn check digit — the one thing about a card number that is true outside
 * this codebase.
 *
 * A 16-digit Iranian card carries a Luhn check digit, so a mistyped number is
 * detectable without asking anyone. It is worth having: `payment_cards` in
 * production holds `5054161716277062`, which fails this test and therefore
 * cannot be a real card. That row silently broke claim-to-account resolution
 * for one bank until a human counted the digits (BUGS-FOR-ADMIN.md item 4).
 *
 * Takes normalized ASCII digits. Anything else is not a card number.
 */
export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function maskCardDigits(digits: string): string {
  if (digits.length < 4) return '****';
  return `**** **** **** ${digits.slice(-4)}`;
}

/** Display full 16-digit card in 4×4 groups (admin views only). */
export function formatCardDigitsForDisplay(digits: string): string {
  if (digits.length !== 16) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}`;
}

/** Toman → IRR (explicit, single conversion helper). */
export function tomanToIrr(amountToman: number): number {
  if (!Number.isInteger(amountToman) || amountToman < 0) {
    throw new Error('amountToman must be a non-negative integer');
  }
  return amountToman * 10;
}
