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
 * A legacy cell that is supposed to be text, decided rather than cast.
 *
 * `type Row` in `migrate.ts` said every column was `string | null` for months.
 * It is not: `information_schema` on the 2026-08-11 dump has 30 `int` columns,
 * 2 `tinyint` and 4 `json` beside its 235 `varchar` and 35 `text`, and mysql2
 * hands the first two back as JavaScript **numbers** whatever `dateStrings` and
 * `bigNumberStrings` are set to. One of those two `tinyint`s — `user.roll_Status`
 * — was compared against `'0'`, was therefore `true` for all 963 rows, and would
 * have migrated every customer who never accepted the shop's rules as having
 * accepted them. The compiler could not object; the declared type said both
 * sides were strings.
 *
 * Widening `Row` makes the compiler point at all 48 places a legacy cell reaches
 * a transform. This is where they land, so the question «what does a number mean
 * here» is answered once, in the open:
 *
 *   - **A string** is what almost every one of them is. Measured, not assumed:
 *     of the 36 non-text columns in the dump, exactly one (`user.Balance`) is
 *     read into a transform at all, and it goes to `tomanToIrr`, which has taken
 *     numbers since it was written.
 *   - **A `Date`** can only appear if `connectMysql` loses `dateStrings: true`.
 *     Formatted rather than refused, because the shape it produces is the one
 *     `tehranString` already parses, and a silent config drift that stopped the
 *     migration dead would be found immediately anyway.
 *   - **A safe integer** becomes its digits. `String(1000043001)` is the same
 *     ten characters MySQL had, so an id column that changes from `varchar` to
 *     `int` on the real cutover dump keeps working instead of throwing on a
 *     value nothing was wrong with.
 *   - **Anything else throws** — a float, a non-finite, an integer past 2^53,
 *     an object. Each of those loses something on the way to a string, and this
 *     migration moves money: a value we cannot carry exactly is a stop, not a
 *     best effort.
 *
 * `phone` and `cardDigits` do not use this. Their rule is stricter and it is
 * written where they are.
 */
export function legacyText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return (
      `${p(value.getFullYear(), 4)}-${p(value.getMonth() + 1)}-${p(value.getDate())} ` +
      `${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`
    );
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new TransformError(
    field,
    value,
    `expected text, got ${typeof value} — a value that cannot become its own digits ` +
      'exactly is not converted here; decide what it means at the column',
  );
}

/**
 * The same, for the two columns where a number is never acceptable.
 *
 * A phone number as a `number` has already lost its leading zero before this
 * function sees it, and «۹۱۲…» instead of «۰۹۱۲…» is invisible in a table of
 * 11,241 rows. A 16-digit card is past `Number.MAX_SAFE_INTEGER`, so it arrives
 * already rounded — and the whole point of `isLuhnValid` is that one wrong digit
 * is exactly what this migration had to settle once before.
 *
 * Neither can be repaired downstream, so neither is accepted.
 */
function legacyDigitsText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new TransformError(
    field,
    value,
    `expected text, got ${typeof value} — a leading zero and a 16th digit do not ` +
      'survive being a number, and neither loss is visible afterwards',
  );
}

/**
 * 2,924 rows literally store the string 'NOT_USERNAME' where a Telegram
 * username would go. Carrying that forward would put a fake username on a
 * quarter of the customer base.
 */
export function username(value: unknown): string | null {
  const text = legacyText(value, 'user.username');
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === 'NOT_USERNAME') return null;
  return trimmed;
}

/** Every user row stores the literal 'none' in `number`; none has a real phone. */
export function phone(value: unknown): string | null {
  const text = legacyDigitsText(value, 'user.number');
  if (!text) return null;
  const trimmed = text.trim();
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
): (value: unknown) => T {
  return (value) => {
    // Through `legacyText` like everything else, so a column that turns numeric
    // is reported as an unmapped value with its digits rather than as `[object]`.
    const key = (legacyText(value, field) ?? '').trim();
    const mapped = table[key];
    if (mapped === undefined) {
      throw new TransformError(
        field,
        value,
        `unmapped legacy value; known: ${Object.keys(table).join(', ')}`,
      );
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

/**
 * The same legacy status read as the state of the **sale**, not of the service.
 *
 * Derived from `subscriptionStatus` rather than from a second table of legacy
 * strings, so the two can never learn about a status separately — a spelling
 * added to one is added to both. A service that was later disabled, removed or
 * put on hold was still bought and paid for; only `unpaid` and `Unsuccessful`
 * mean no money changed hands.
 *
 * `unpaid` becomes EXPIRED rather than AWAITING_PAYMENT, and the step that
 * calls this says why. The short version is 1,886 Telegram messages.
 */
export function invoiceOrderStatus(value: unknown): 'COMPLETED' | 'EXPIRED' | 'FAILED' {
  const status = subscriptionStatus(value);
  if (status === 'PENDING_PAYMENT') return 'EXPIRED';
  if (status === 'FAILED') return 'FAILED';
  return 'COMPLETED';
}

export const ORDER_KIND = {
  extend_user: 'RENEWAL',
  // Carries {"volume_value": "10", ...} — extra gigabytes, not extra seats.
  extra_user: 'ADD_VOLUME',
  extra_time_user: 'ADD_TIME',
  transfertouser: 'TRANSFER',
} as const;
export const orderKind = strictMap(ORDER_KIND, 'service_other.type');

/**
 * Legacy `marzban_panel.type`, restricted to the ones that survive the import.
 *
 * Mirzabot can store eleven types (`keyboard.php:1204-1225`). Only these three
 * lowercase into a value `provisioning_providers.kind` allows, so anything else
 * would fail the CHECK at insert time. Naming them here turns that into a
 * preflight BLOCKER with the panel's name in it, before the migration runs.
 *
 * `pasarguard` is deliberately absent: `admin.php:750` rewrites it to `marzban`
 * on the way in, so it can never appear in this column. The distinction lives
 * in `version_panel` — see PANEL_VERSION.
 */
export const PANEL_TYPE = {
  marzban: 'marzban',
  marzneshin: 'marzneshin',
  hiddify: 'hiddify',
} as const;

/**
 * `marzban_panel.version_panel` — which API generation, and therefore which
 * panel software. '1' is PasarGuard (`admin.php:749`).
 *
 * The column is NOT NULL in the legacy schema, so the case to guard is the
 * empty string, and it is deliberately not mapped: a panel nobody has set is
 * one a person should look at, not one that defaults into a kind speaking the
 * wrong protocol. Verified by inserting `version_panel = ''` into the
 * simulation MySQL and watching preflight refuse the migration.
 */
export const PANEL_VERSION = {
  '0': 'marzban',
  '1': 'pasarguard',
} as const;

export const LEASE_STATUS = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export const leaseStatus = strictMap(LEASE_STATUS, 'card_assignment_leases.status');

/**
 * Legacy `agent`, which appears on BOTH `user` and `product` rows and means the
 * same thing in each: who this row is for.
 *
 * index.php:299 pins the domain — `in_array($user['agent'], ["n","n2","f"])`.
 * 'f' is an ordinary customer; 'n' and 'n2' are the two reseller tiers. The
 * earlier version tested `=== 'n'` and so read 'n2' as an ordinary customer.
 * Production carries no 'n2' row today, which is the only reason that never
 * showed: a second-tier reseller would have migrated as a normal customer, and
 * a reseller-only product as one anybody can buy.
 *
 * Anything outside the domain throws. A wrong `false` here is invisible — the
 * customer simply never sees the product — which is exactly the kind of silent
 * fallback this migration refuses to make.
 */
/**
 * A legacy `tinyint(1)` flag, converted without trusting what type it arrives as.
 *
 * mysql2 returns `tinyint(1)` as a **number**, and `type Row` in `migrate.ts`
 * declared every field `string | null` until 2026-08-23. So `r.roll_Status !== '0'` compared a
 * number against a string, was `true` for every row, and would have marked all
 * 963 customers who never accepted the shop's rules as having accepted them.
 * The compiler could not see it: the declared type said the comparison was
 * between two strings, and TypeScript had no reason to object.
 *
 * The repair is not a cast. A cast would move the same assumption somewhere
 * quieter. This takes `unknown` and decides, so the column's real type stops
 * being something a reader has to know.
 *
 * `null` and `undefined` are false — a flag that was never set has not been set.
 * Anything else throws, for the reason `isReseller` throws: a wrong `false`
 * here is invisible, and «a customer silently skipped a gate» is not a failure
 * anyone reports.
 */
export function legacyBool(value: unknown, field: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '' || s === '0') return false;
    if (s === '1') return true;
  }
  throw new Error(
    `unmapped legacy flag ${field} = ${JSON.stringify(value)} (${typeof value}) — ` +
      'the domain is 0/1, "0"/"1", "" and NULL. Add it here deliberately; do not default it.',
  );
}

export function isReseller(value: unknown): boolean {
  const agent = (legacyText(value, 'user.agent') ?? '').trim();
  // Absent, not unmapped: a row that never had the column set is an ordinary
  // customer, which is what the legacy default has always meant.
  if (agent === '' || agent === 'f') return false;
  if (agent === 'n' || agent === 'n2') return true;
  throw new Error(
    `unmapped legacy agent value ${JSON.stringify(agent)} — the domain is ` +
      "'f', 'n', 'n2' (index.php:299). Add it here deliberately; do not default it.",
  );
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
export function userStatus(value: unknown): 'ACTIVE' | 'BLOCKED' {
  const raw = (legacyText(value, 'User_Status') ?? '').trim().toLowerCase();
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
export function stepToken(value: unknown): {
  operationType: string | null;
  raw: string | null;
} {
  const text = legacyText(value, 'Payment_report.id_invoice');
  if (!text) return { operationType: null, raw: null };
  const raw = text.trim();
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

export function cardDigits(value: unknown): string | null {
  const text = legacyDigitsText(value, 'card_number');
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
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
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/** Column names in the payment hub that carry epoch milliseconds. */
export const HUB_EPOCH_COLUMNS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
  'submitted_at',
  'paid_clicked_at',
  'receipt_submitted_at',
  'bank_timestamp',
  'sms_timestamp',
  'received_at',
  'processed_at',
  'reviewed_at',
  'assigned_at',
  'classified_at',
  'declined_at',
  'restored_at',
  'expires_at',
  'applied_at',
  'last_seen_at',
  'last_success_at',
  'last_auth_failure_at',
  'activated_at',
  'revoked_at',
  'last_used_at',
  'seen_at',
  'last_attempt_at',
  'next_attempt_at',
  'last_seen_transaction_at',
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

export function tehranString(value: unknown, field: string): string | null {
  const text = legacyText(value, field);
  if (!text) return null;
  const raw = text.trim();
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
export function json(value: unknown, fallback: unknown = {}): unknown {
  // A `json` column comes back from mysql2 already parsed — an object, not text
  // — so it is returned as it is rather than pushed through `JSON.parse` twice.
  if (typeof value === 'object' && value !== null) return value;
  const text = legacyText(value, 'json');
  if (!text) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Turns JSON-shaped text back into JSON.
 *
 * MySQL hands every one of these columns back as a string, and `legacyAttrs`
 * stores what it is handed, so `inbounds` arrived in `config` as the six
 * characters `"[42,2]"` rather than as a list. Nothing noticed, because the
 * only reader is a panel we had never called with a migrated row — and it
 * answers 422, not something a test would see.
 *
 * A string that does not parse is left exactly as it was. Rewriting it into
 * `{}` (which is what `json()` alone would do) would turn a value we do not
 * understand into a value we invented.
 *
 * ponytail: applied at the provider call site, not inside `legacyAttrs`.
 * `products.attrs` holds JSON-as-text for the same reason, but nothing reads it
 * and no production row has a value — widen this the day something does.
 */
export function parseJsonStrings(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const looksJson = typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'));
    out[k] = looksJson ? json(v, v) : v;
  }
  return out;
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
