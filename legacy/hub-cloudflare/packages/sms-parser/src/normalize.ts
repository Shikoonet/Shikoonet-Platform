/**
 * Deterministic Persian/Arabic text + number normalization.
 *
 * - Persian digits ۰-۹ and Arabic-Indic digits ٠-٩ → ASCII 0-9.
 * - Zero-width non-joiner (U+200C), zero-width joiner (U+200D), BOM (U+FEFF),
 *   non-breaking space (U+00A0) → ASCII space / dropped.
 * - Persian thousands separator `،` and ASCII `,` → both accepted; collapsed.
 * - Currency: ریال / IRR / rial → unit IRR; تومان / toman → ×10 → IRR.
 *   If both currencies appear anywhere in the text, the message is
 *   AMBIGUOUS_CURRENCY — the caller must flag NEEDS_REVIEW.
 * - Arabic letters ي / ك / ة folded to Persian ی / ک / ه so the same word
 *   written in either script normalizes identically.
 * - CRLF / LF / CR / Persian/English colons all collapse to ASCII equivalents.
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

// Arabic-script letters that share a code-point with a Persian counterpart but
// look subtly different. We fold them so parsers see one normalized word.
const ARABIC_TO_PERSIAN: Record<string, string> = {
  ي: 'ی',
  ك: 'ک',
  ة: 'ه',
};

export interface NormalizedNumber {
  raw: string;
  value: number; // integer IRR (تومان amounts already ×10)
  currency: 'IRR' | 'TOMAN' | 'AMBIGUOUS' | 'NONE';
}

export interface NormalizedText {
  text: string;
  warnings: string[];
}

const TOMAN_PATTERNS: RegExp[] = [/تومان/, /\btoman\b/i];
const RIAL_PATTERNS: RegExp[] = [/ریال/, /ريال/, /\bIRR\b/i, /\brial\b/i];

function digitToAscii(ch: string): string {
  const pIdx = PERSIAN_DIGITS.indexOf(ch);
  if (pIdx >= 0) return String(pIdx);
  const aIdx = ARABIC_DIGITS.indexOf(ch);
  if (aIdx >= 0) return String(aIdx);
  return ch;
}

/**
 * Strip Persian/Arabic commas and the currency suffix from a localized
 * amount string. Returns null when the string is malformed (extra digits,
 * non-numeric chars, negative sign, decimal point, etc.). Never guesses.
 */
export function parseIrr(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  // Strip currency keywords; keep digits, ASCII/Persian/Arabic commas
  // (`,`, `،` U+060C, `٬` U+066C), whitespace.
  const stripped = raw
    .replace(/ریال|ريال|تومان|\bIRR\b|\brial\b|\btoman\b/gi, '')
    .replace(/\s+/g, '')
    .replace(/[،,٬]/g, '');
  if (!/^\d+$/.test(stripped)) return null;
  if (stripped.length > 18) return null; // cap to avoid JS-precision surprises
  return Number.parseInt(stripped, 10);
}

export function normalizeText(raw: string): NormalizedText {
  let out = '';
  const warnings: string[] = [];
  // Normalize CRLF/CR → LF first so line splits survive across OSes.
  const crlfNormalized = raw.replace(/\r\n?/g, '\n');
  for (const ch of crlfNormalized) {
    if (STRIP_CHARS.has(ch)) {
      out += ' ';
      continue;
    }
    const folded = ARABIC_TO_PERSIAN[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    out += digitToAscii(ch);
  }
  // Collapse runs of whitespace; keep newlines so multi-line layouts survive
  // (parsers split on \n themselves).
  // Also fold Persian/Arabic thousands separators (`,`, `،` U+060C, `٬`
  // U+066C) to ASCII comma so amount-regexes stay simple.
  const text = out
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[،٬]/g, ',')
    .trim();
  if (/[‌‍‎‏‪‫‬‭‮⁦⁧⁨⁩]/.test(raw)) {
    warnings.push('contained_zero_width_chars');
  }
  return { text, warnings };
}

function textHasToman(text: string): boolean {
  return TOMAN_PATTERNS.some((re) => re.test(text));
}
function textHasRial(text: string): boolean {
  return RIAL_PATTERNS.some((re) => re.test(text));
}

function toIrr(value: number, currency: NormalizedNumber['currency']): number {
  return currency === 'TOMAN' ? value * 10 : value;
}

/** First (largest) amount in the text. Use this for single-value parsing. */
export function extractAmount(text: string): NormalizedNumber | null {
  const all = extractAllAmounts(text);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.value > a.value ? b : a), all[0]!);
}

/**
 * Every digit run in the text. Values are converted to integer IRR
 * (تومان amounts are already ×10). If both currencies appear anywhere in
 * the text, every amount is marked AMBIGUOUS.
 */
export function extractAllAmounts(text: string): NormalizedNumber[] {
  const wholeTextToman = textHasToman(text);
  const wholeTextRial = textHasRial(text);
  const wholeTextAmbiguous = wholeTextToman && wholeTextRial;
  const defaultCurrency: NormalizedNumber['currency'] = wholeTextAmbiguous
    ? 'AMBIGUOUS'
    : wholeTextToman
      ? 'TOMAN'
      : wholeTextRial
        ? 'IRR'
        : 'NONE';

  const re = /(\d{1,3}(?:[,،]\d{3})+|\d+)/g;
  const out: NormalizedNumber[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const intPart = raw.replace(/[,،]/g, '');
    const value = Number.parseInt(intPart, 10);
    if (!Number.isFinite(value)) continue;
    out.push({
      raw,
      value: toIrr(value, defaultCurrency),
      currency: defaultCurrency,
    });
  }
  return out;
}
