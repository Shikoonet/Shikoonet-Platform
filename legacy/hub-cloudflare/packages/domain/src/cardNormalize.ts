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
