/**
 * Accept Android epoch-ms strings and iPhone / Apple Shortcuts timestamps.
 * Returns normalized epoch milliseconds, or null when unparseable.
 */

const EPOCH_DIGITS_RE = /^\d{10,16}$/;

/** Loose ISO date prefix — Shortcuts may emit RFC3339 variants Date.parse accepts. */
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

function epochDigitsToMs(digits: string): number | null {
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 10-digit values are epoch seconds (Shortcuts UNIX time / iOS intervals).
  return digits.length <= 10 ? n * 1000 : n;
}

function numericEpochToMs(n: number): number | null {
  const t = Math.trunc(n);
  if (!Number.isFinite(t) || t <= 0) return null;
  return t < 1e11 ? t * 1000 : t;
}

export function parseIngestTimestamp(raw: string | number): number | null {
  if (typeof raw === 'number') {
    return numericEpochToMs(raw);
  }

  const text = raw.trim();
  if (!text) return null;

  if (EPOCH_DIGITS_RE.test(text)) {
    return epochDigitsToMs(text);
  }

  if (!ISO_DATE_PREFIX_RE.test(text)) return null;

  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeIngestTimestamp(raw: string | number): string | null {
  const ms = parseIngestTimestamp(raw);
  return ms == null ? null : String(ms);
}
