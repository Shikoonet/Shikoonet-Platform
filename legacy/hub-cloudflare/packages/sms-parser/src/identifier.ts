/**
 * Identifier normalization for matching financial accounts.
 *
 * Two representations are produced for every identifier:
 *
 *   - `normalizedValue`: Persian/Arabic digits → ASCII, bidi/zero-width
 *     characters stripped, internal whitespace removed, comma/period
 *     separators collapsed, the embedded dots preserved when the bank
 *     format uses them (e.g. "110.9992.2377306.1"). This is the canonical
 *     equality key.
 *
 *   - `digitsOnlyValue`:        normalized value with all non-digits
 *     removed. Used as a secondary equality key for digit-only identifiers
 *     (card numbers, account numbers) so "300422286226" and "300-422-286226"
 *     match.
 *
 * Domain: the renderer leaks no full identifier; callers must display
 * `displayValueMasked` for UI and reserve the full value for server-side
 * matching only.
 *
 * Tested edge cases (see packages/sms-parser/test/identifier.test.ts):
 *   - Persian digits ۰-۹
 *   - Arabic digits ٠-٩
 *   - bidi controls: U+200E, U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF
 *   - dotted account identifiers (110.9992.2377306.1)
 *   - card numbers with dashes/spaces
 *   - empty input
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const STRIP_CHARS = new Set<string>([
  '‌', // ZWNJ
  '‍', // ZWJ
  '﻿', // BOM
  ' ', // NBSP
  '‎', // U+200E LEFT-TO-RIGHT MARK
  '‏', // U+200F RIGHT-TO-LEFT MARK
  '‪', // U+202A LEFT-TO-RIGHT EMBEDDING
  '‫', // U+202B RIGHT-TO-LEFT EMBEDDING
  '‬', // U+202C POP DIRECTIONAL FORMATTING
  '‭', // U+202D LEFT-TO-RIGHT OVERRIDE
  '‮', // U+202E RIGHT-TO-LEFT OVERRIDE
  '⁦', // U+2066 LEFT-TO-RIGHT ISOLATE
  '⁧', // U+2067 RIGHT-TO-LEFT ISOLATE
  '⁨', // U+2068 FIRST STRONG ISOLATE
  '⁩', // U+2069 POP DIRECTIONAL ISOLATE
]);

export function normalizeIdentifier(raw: string | null | undefined): {
  normalizedValue: string;
  digitsOnlyValue: string;
  displayValueMasked: string;
  lastFour: string | null;
} {
  if (!raw) return emptyIdentifier();
  // Step 1: replace digits.
  let s = '';
  for (const ch of raw) {
    if (STRIP_CHARS.has(ch)) {
      s += ' ';
      continue;
    }
    const pIdx = PERSIAN_DIGITS.indexOf(ch);
    if (pIdx >= 0) {
      s += String(pIdx);
      continue;
    }
    const aIdx = ARABIC_DIGITS.indexOf(ch);
    if (aIdx >= 0) {
      s += String(aIdx);
      continue;
    }
    s += ch;
  }
  // Step 2: collapse internal whitespace; remove Arabic/Persian commas but
  // PRESERVE dots — bank formats like 110.9992.2377306.1 rely on embedded dots.
  const normalizedValue = s.replace(/\s+/g, '').replace(/[،,٬]/g, '');
  const digitsOnlyValue = normalizedValue.replace(/\D+/g, '');
  const lastFour = digitsOnlyValue.length >= 4 ? digitsOnlyValue.slice(-4) : null;
  const displayValueMasked = maskIdentifier(normalizedValue);
  return { normalizedValue, digitsOnlyValue, displayValueMasked, lastFour };
}

function emptyIdentifier() {
  return {
    normalizedValue: '',
    digitsOnlyValue: '',
    displayValueMasked: '',
    lastFour: null,
  };
}

/**
 * Mask an identifier for display. Dots (and other non-digit separators) are
 * preserved so the recognizable shape survives; the leading digits are
 * replaced with `*`; the four trailing digits stay visible.
 *
 *   "110.9992.2377306.1" → "***.****.*****3061"
 *   "300422286226"       → "********8226"
 *   "12"                 → "**"
 */
export function maskIdentifier(value: string): string {
  if (!value) return '';
  const totalDigits = value.replace(/\D+/g, '').length;
  if (totalDigits <= 4) return value.replace(/[0-9]/g, '*');
  // Walk the original string left-to-right; reveal the digit only when
  // ≤ 4 digits remain to be emitted. Track how many digits we have already
  // committed (regardless of whether they were '*' or the digit itself).
  let digitsCommitted = 0;
  let out = '';
  for (const ch of value) {
    if (ch >= '0' && ch <= '9') {
      digitsCommitted += 1;
      const digitsRemaining = totalDigits - digitsCommitted;
      out += digitsRemaining < 4 ? ch : '*';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Shape persisted on `parser_evidence_json.detectedIdentifiers` AND on
 * `transaction_detected_identifiers`. The fields named
 * `normalizedValue` / `maskedValue` are the wire form used by the
 * dashboard API; the canonical ingest helper maps them to the table's
 * `normalized_value` / `display_value_masked` columns.
 */
export interface DetectedIdentifier {
  type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
  normalizedValue: string;
  maskedValue: string;
  confidence: number;
  parserId: string;
}

/**
 * Convert a raw extracted string (e.g. "30101883751600" or
 * "110.9992.2377306.1") into the typed wire shape. Returns null when the
 * string has fewer than 5 digits after normalization — i.e. there is no
 * identifier to persist and the parser must not pretend one exists.
 */
export function detectedIdentifierFromRaw(
  raw: string,
  parserId: string,
  confidence: number,
): DetectedIdentifier | null {
  const n = normalizeIdentifier(raw);
  if (!n.normalizedValue || n.normalizedValue.replace(/\D/g, '').length < 5) {
    return null;
  }
  return {
    type: 'ACCOUNT_NUMBER',
    normalizedValue: n.normalizedValue,
    maskedValue: n.displayValueMasked,
    confidence,
    parserId,
  };
}
