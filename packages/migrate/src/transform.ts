/**
 * Pure legacy-to-new value transforms.
 *
 * Everything here is a function of its arguments — no database, no clock, no
 * environment. That is deliberate: these transforms are where money changes
 * unit, where three timestamp formats become one, and where ten legacy status
 * strings collapse into six. Every bug that silently corrupts the migration
 * lives in this file, so this file is the one that gets unit tests.
 *
 * Timestamps are NOT converted here. They are handed to Postgres as raw legacy
 * values with an explicit conversion expression (see sqlExpr below), because
 * Postgres carries the full timezone database and JavaScript does not.
 */

/** A legacy value that could not be interpreted. Never silently coerced. */
export class TransformError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`${field}: ${reason} (got ${JSON.stringify(value)})`);
    this.name = 'TransformError';
  }
}

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

/**
 * Mirzabot stores Toman. The platform stores IRR. 1 Toman = 10 IRR.
 *
 * bigint, not number: 671,442,654 Toman of historical payments is 6.7e9 IRR,
 * which is still inside Number.MAX_SAFE_INTEGER — but the running total of a
 * busy year is not, and a rounding error in money is not recoverable.
 */
export function tomanToIrr(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?\d+$/.test(raw)) {
    throw new TransformError('amount', value, 'not an integer Toman amount');
  }
  return BigInt(raw) * 10n;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** Telegram ids are stored as varchar in MySQL; all 11,241 are numeric. */
export function telegramId(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') {
    throw new TransformError('telegram_id', value, 'missing');
  }
  const raw = String(value).trim();
  if (!/^\d{1,19}$/.test(raw)) {
    throw new TransformError('telegram_id', value, 'not a numeric Telegram id');
  }
  return BigInt(raw);
}

/**
 * 2,924 rows literally store the string 'NOT_USERNAME' where a Telegram
 * username would go. Carrying that forward would put a fake username on a
 * quarter of the customer base.
 */
export function username(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'NOT_USERNAME') return null;
  return trimmed;
}

/** Every user row stores the literal 'none' in `number`; none has a real phone. */
export function phone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'none' || trimmed === '0') return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// enumerations
// ---------------------------------------------------------------------------

/**
 * Maps a legacy value through a table, refusing anything unlisted.
 *
 * The refusal is the point. A silent fallback to 'UNKNOWN' would let a legacy
 * value nobody anticipated pass through as a plausible-looking row; the
 * migration would report success and the wrong data would be live. Anything
 * unmapped stops the run and gets a human decision.
 */
function strictMap<T extends string>(
  table: Readonly<Record<string, T>>,
  field: string,
): (value: string | null | undefined) => T {
  return (value) => {
    const key = (value ?? '').trim();
    const mapped = table[key];
    if (mapped === undefined) {
      throw new TransformError(field, value, `unmapped legacy value; known: ${Object.keys(table).join(', ')}`);
    }
    return mapped;
  };
}

export const PAYMENT_STATUS = {
  paid: 'PAID',
  expire: 'EXPIRED',
  reject: 'REJECTED',
  Unpaid: 'PENDING',
  processing: 'PROCESSING',
  // The customer pressed "I paid" and the receipt is waiting on a decision.
  waiting: 'AWAITING_REVIEW',
} as const;
export const paymentStatus = strictMap(PAYMENT_STATUS, 'payment_Status');

export const PAYMENT_METHOD = {
  'cart to cart': 'CARD_TO_CARD',
  'arze digital offline': 'CRYPTO',
  plisio: 'CRYPTO',
  'Star Telegram': 'TELEGRAM_STARS',
  'add balance by admin': 'ADMIN_CREDIT',
  'low balance by admin': 'ADMIN_DEBIT',
} as const;
export const paymentMethod = strictMap(PAYMENT_METHOD, 'Payment_Method');

export const SUBSCRIPTION_STATUS = {
  active: 'ACTIVE',
  unpaid: 'PENDING_PAYMENT',
  send_on_hold: 'ON_HOLD',
  disabled: 'DISABLED',
  // Not a typo on our side: production contains both spellings, from a bug in
  // the PHP that writes this column. Both mean disabled.
  disabledn: 'DISABLED',
  disablebyadmin: 'DISABLED',
  removeTime: 'REMOVED',
  removevolume: 'REMOVED',
  removebyuser: 'REMOVED',
  Unsuccessful: 'FAILED',
} as const;
export const subscriptionStatus = strictMap(SUBSCRIPTION_STATUS, 'invoice.Status');

export const ORDER_KIND = {
  extend_user: 'RENEWAL',
  // Carries {"volume_value": "10", ...} — extra gigabytes, not extra seats.
  extra_user: 'ADD_VOLUME',
  extra_time_user: 'ADD_TIME',
  transfertouser: 'TRANSFER',
} as const;
export const orderKind = strictMap(ORDER_KIND, 'service_other.type');

export const LEASE_STATUS = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export const leaseStatus = strictMap(LEASE_STATUS, 'card_assignment_leases.status');

/** `agent = 'n'` marks a reseller; see panel/users.php:50 counting them. */
export function isReseller(value: string | null | undefined): boolean {
  return (value ?? '').trim() === 'n';
}

/**
 * Case-insensitive on purpose, unlike the other maps.
 *
 * Production holds 'Active' on 11,192 rows and 'active' on 5 — two code paths
 * writing the same state with different capitalisation. MySQL's default
 * collation is case-insensitive, so the bot has always treated them as one
 * value and every query already agrees. Folding case here reproduces the
 * behaviour that has been live for years, rather than inventing a distinction.
 */
export function userStatus(value: string | null | undefined): 'ACTIVE' | 'BLOCKED' {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'active') return 'ACTIVE';
  if (raw === 'block') return 'BLOCKED';
  throw new TransformError('User_Status', value, 'unmapped legacy value');
}

// ---------------------------------------------------------------------------
// the broken payment-to-invoice link
// ---------------------------------------------------------------------------

/**
 * `Payment_report.id_invoice` looks like a foreign key and is not one. It holds
 * 'getconfigafterpay|6714538686_28ed': a step name, a user id, and a random
 * token. Verified against the production dump — zero of the 4,629 rows join to
 * `invoice` by any interpretation of this value.
 *
 * The prefix is the only part with meaning, so that is all we promote to a
 * column. The whole string is preserved separately.
 */
export function stepToken(value: string | null | undefined): {
  operationType: string | null;
  raw: string | null;
} {
  if (!value) return { operationType: null, raw: null };
  const raw = value.trim();
  if (raw === '') return { operationType: null, raw: null };
  const pipe = raw.indexOf('|');
  if (pipe <= 0) {
    // 101 rows hold the literal '0'; there is no operation in them.
    return { operationType: null, raw };
  }
  return { operationType: raw.slice(0, pipe), raw };
}

// ---------------------------------------------------------------------------
// card numbers
// ---------------------------------------------------------------------------

/**
 * Luhn check digit. Iranian bank cards are 16 digits and must satisfy it.
 *
 * This is not decoration: it is what settled which of two one-digit-apart card
 * numbers was real. All 25 bot cards pass; 25 of 26 hub cards pass, and the one
 * failure was exactly the disputed number. See BUGS-FOR-ADMIN.md item 4.
 */
export function isLuhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function cardDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits === '' ? null : digits;
}

// ---------------------------------------------------------------------------
// timestamps — converted by Postgres, not here
// ---------------------------------------------------------------------------

/**
 * SQL expressions that turn a legacy timestamp into `timestamptz`.
 *
 * `tehranString` uses an explicit format mask rather than a bare cast, so the
 * result cannot change with the server's `DateStyle` setting. Verified to give
 * an identical answer under both `ISO, MDY` and `ISO, DMY`.
 *
 * The timezone is not a guess: Payment_report row 4730 ('2026/08/11 23:26:33')
 * and its matching invoice epoch (1786478188 = 19:56:28 UTC) sit exactly 3h30m
 * apart, which is Tehran's offset.
 */
export const sqlExpr = {
  /** 'YYYY/MM/DD HH:MM:SS' written in Tehran local time. */
  tehranString: (ph: string) =>
    `(to_timestamp(${ph}, 'YYYY/MM/DD HH24:MI:SS')::timestamp AT TIME ZONE 'Asia/Tehran')`,
  /** Unix epoch seconds, stored as a varchar. */
  epochSeconds: (ph: string) => `to_timestamp(${ph}::double precision)`,
  /** Unix epoch milliseconds (the payment hub's format). */
  epochMillis: (ph: string) => `to_timestamp(${ph}::double precision / 1000.0)`,
} as const;

/**
 * A payment-hub epoch-milliseconds column, tolerating the rows that are not.
 *
 * SQLite does not enforce column types, so three `access_users` rows in
 * production hold 'YYYY-MM-DD HH:MM:SS' in a column declared INTEGER — written
 * by a hand-run statement using CURRENT_TIMESTAMP, which SQLite emits in UTC.
 * Postgres does enforce the type, so those rows have to be normalised here or
 * the whole hub import fails on them.
 */
export function hubEpochMillis(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) throw new TransformError(field, value, 'neither epoch millis nor a UTC datetime');
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
}

/** Column names in the payment hub that carry epoch milliseconds. */
export const HUB_EPOCH_COLUMNS: ReadonlySet<string> = new Set([
  'created_at', 'updated_at', 'submitted_at', 'paid_clicked_at',
  'receipt_submitted_at', 'bank_timestamp', 'sms_timestamp', 'received_at',
  'processed_at', 'reviewed_at', 'assigned_at', 'classified_at', 'declined_at',
  'restored_at', 'expires_at', 'applied_at', 'last_seen_at', 'last_success_at',
  'last_auth_failure_at', 'activated_at', 'revoked_at', 'last_used_at',
  'seen_at', 'last_attempt_at', 'next_attempt_at', 'last_seen_transaction_at',
]);

/** Rejects epoch values outside a sane window instead of storing year 1970. */
export function epochSeconds(
  value: string | number | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new TransformError(field, value, 'not an epoch');
  const n = Number(raw);
  // 2001-09-09 .. 2033-05-18. Anything outside is a unit mistake (millis in a
  // seconds column) or corruption, and must not become a plausible timestamp.
  if (n < 1_000_000_000 || n > 2_000_000_000) {
    throw new TransformError(field, value, 'epoch outside the plausible range');
  }
  return raw;
}

/**
 * A wall-clock timestamp written in Tehran local time.
 *
 * Two separators appear in production: the bot writes 'YYYY/MM/DD HH:MM:SS'
 * and MySQL's own DATETIME default writes 'YYYY-MM-DD HH:MM:SS'
 * (revenue_adjustment_log). Both are normalised to slashes so a single format
 * mask converts them.
 *
 * The DATETIME column is Tehran too, not UTC: its newest row is 21:58 local on
 * the dump date, which as UTC would fall after the dump was taken.
 */
const TEHRAN_STRING = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}:\d{2}:\d{2})/;

export function tehranString(
  value: string | null | undefined,
  field: string,
): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (raw === '' || raw === '0000-00-00 00:00:00') return null;
  const m = TEHRAN_STRING.exec(raw);
  if (!m) {
    throw new TransformError(field, value, 'not YYYY/MM/DD or YYYY-MM-DD HH:MM:SS');
  }
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}`;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/** Parses a JSON column, returning a fallback rather than throwing on garbage. */
export function json(value: string | null | undefined, fallback: unknown = {}): unknown {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Legacy columns with no home in the new schema, minus the ones we drop. */
export function legacyAttrs(
  row: Record<string, unknown>,
  claimed: readonly string[],
  dropped: readonly string[] = [],
): Record<string, unknown> {
  const skip = new Set([...claimed, ...dropped]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (skip.has(k)) continue;
    if (v === null || v === '' || v === '0') continue; // legacy "unset"
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
