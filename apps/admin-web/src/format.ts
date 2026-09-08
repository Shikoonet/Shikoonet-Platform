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

/**
 * Seconds included, for the finance screens only.
 *
 * A payment claim carries two timestamps that can be a few seconds apart — when
 * the phone received the bank SMS and when the server ingested it — and the
 * five-minute auto-verify window is decided on their difference. Rounded to the
 * minute they look identical, which is exactly the case an operator is looking
 * at the screen to understand.
 */
const TEHRAN_SECONDS = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Epoch milliseconds as well as ISO strings.
 *
 * The panel's own API answers ISO; the finance screens, which came from the
 * payment hub, carry `bank_timestamp` and friends as numbers. One formatter
 * taking both is what let the second copy of this module be deleted — and the
 * second copy formatted in the browser's own zone, so an admin travelling saw a
 * different time than the bot had shown the customer.
 */
type Stamp = string | number | null | undefined;

function msOf(value: Stamp): number | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Jalali date and time, Tehran. Returns the raw value if it will not parse. */
export function dateTime(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN.format(ms);
}

/** Jalali date, time and seconds, Tehran. */
export function dateTimeSeconds(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN_SECONDS.format(ms);
}

/** Jalali date only, Tehran. */
export function dateOnly(value: Stamp): string {
  const ms = msOf(value);
  if (ms == null) return typeof value === 'string' && value ? value : '—';
  return TEHRAN_DATE.format(ms);
}

/**
 * The instant a code dated `YYYY-MM-DD` stops working.
 *
 * `<input type="date">` hands back a bare calendar date, and the column it ends
 * up in is a `timestamptz`. The bot refuses a code when `expires_at <= now`, so
 * the right instant is the START of the following Tehran day: a code «until 1
 * Shahrivar» then works for all of that day and stops at midnight. Taking the
 * date at face value would cut it short by a day, which is the kind of
 * off-by-one a customer notices and an admin cannot see.
 *
 * Built by asking `Intl` where Tehran's clock stands at that moment rather than
 * by adding a fixed offset. `packages/domain/src/historyRange.ts` keeps its own
 * `TEHRAN_OFFSET_MS`, and duplicating that number here would be a second
 * definition of the same fact — the failure this repository has already had
 * with two Toman formatters. It is not imported instead, because `@shikoo/domain`
 * is a server package and pulling it into the browser bundle to reach one
 * constant costs more than this function does.
 */
export function endOfTehranDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  // Midday UTC on the day AFTER, which is inside that Tehran day whatever the
  // offset is, then walked back to that day's midnight in Tehran.
  const noonNext = Date.UTC(y, m - 1, d + 1, 12, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(noonNext));
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = (at('hour') * 3600 + at('minute') * 60 + at('second')) * 1000;
  return new Date(noonNext - sinceMidnight).toISOString();
}

/** What one gigabyte is here, and everywhere else in this repo. */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Traffic consumed.
 *
 * Two different things are borrowed from two different places, and the first
 * version of this got that wrong in a way only the screen could show.
 *
 * **The rounding is the bot's.** `apps/bot/src/menu.ts` gives the customer one
 * decimal, and two below a tenth of a gigabyte — because "۰٫۰" reads as
 * "nothing" to somebody who has just started using a service. An operator
 * reading a support message that quotes the bot has to see the same figure.
 *
 * **The digits are the panel's.** The first version copied the bot's
 * `toLocaleString('en-US')` along with the rounding, so «مصرف» rendered
 * `0 گیگ` in Latin digits directly beside «حجم» rendering `۱۰ گیگ` in Persian —
 * two adjacent cells in one row disagreeing about what a number looks like.
 * Nothing in a test saw it; walking the deployed screen did. `FA` is what every
 * other number on this panel goes through.
 *
 * `FA.format` of a rounded number drops a trailing zero exactly as the bot's
 * `Number(shown)` does, so 3.0 GB is «۳ گیگ» in both and 3.5 is «۳٫۵».
 */
export function gigabytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const gb = bytes / BYTES_PER_GB;
  const places = gb > 0 && gb < 0.1 ? 2 : 1;
  return `${FA.format(Number(gb.toFixed(places)))} گیگ`;
}

/**
 * A catalogue row's status, in the words the panel uses everywhere else.
 *
 * Here rather than in a page because two screens now read it — «سرویس‌ها» on
 * every row, and «دسته‌بندی‌ها» inside the tier arrangement editor — and the
 * second one having its own copy is how «غیرفعال» and «خاموش» end up on two
 * screens describing one column.
 *
 * Indexed by string, not by a union: the value comes from the API, and a status
 * this build has never heard of should fall through to itself rather than
 * render as «undefined».
 */
export const STATUS_FA: Record<string, string> = {
  ACTIVE: 'فعال',
  HIDDEN: 'پنهان',
  DISABLED: 'غیرفعال',
};


/**
 * The three notes the system writes into `wallet_entries.note`, in Persian.
 *
 * They are English because they are written in English, at insert time:
 * `packages/migrate/src/migrate.ts` stamps «legacy balance carried over
 * unchanged» on every migrated opening balance, `apps/bot/src/wallet.ts`
 * writes «5% of a renewal» and `apps/bot/src/referral.ts` «10% of a first
 * purchase». They then sat untranslated in a Persian table on two screens.
 *
 * Translated here rather than in the database. `kind` already carries the whole
 * meaning of each of these rows — the note only adds a percentage — and
 * `wallet_entries` is append-only by trigger, so "fixing" the wording would
 * mean rewriting a ledger to change a caption. What the operator reads is a
 * presentation question, and this is the presentation layer.
 *
 * A note this function does not recognise is returned as it is. Two kinds of
 * note reach here that must not be touched: one an operator typed themselves
 * (`ADMIN_ADJUST`, already Persian), and one from a build newer than this
 * panel. A row whose reason cannot be translated still has a reason.
 */
export function entryNoteFa(kind: string, note: string | null): string | null {
  if (note === null) return null;
  if (kind === 'OPENING' && note === 'legacy balance carried over unchanged') {
    return 'موجودی اولیه، همان‌طور که از ربات قدیمی منتقل شد';
  }
  const renewal = /^(\d+)% of a renewal$/.exec(note);
  if (kind === 'RENEWAL_CASHBACK' && renewal) return `${count(Number(renewal[1]))}٪ هدیهٔ تمدید`;
  const referral = /^(\d+)% of a first purchase$/.exec(note);
  if (kind === 'REFERRAL_BONUS' && referral) {
    return `${count(Number(referral[1]))}٪ پورسانت اولین خرید زیرمجموعه`;
  }
  return note;
}

/** Who moved the money. Only the system has a name that needs translating. */
export function actorFa(actor: string | null): string | null {
  return actor === 'SYSTEM' ? 'سیستم' : actor;
}

/**
 * A plan name with its own price cut off the end.
 *
 * Every product migrated from Mirzabot carries the Toman price inside its
 * name — «1ماهه-20گیگ-چند کاربر-200.000» — because the legacy bot had no price
 * column on its buttons and put the number in the label. Beside a «مبلغ» column
 * the row then reads the price twice, and the second one is not formatted like
 * the first: Latin digits, a full stop for the thousands group, no unit.
 *
 * Display only. `plan_name_at_sale` is frozen at the moment of sale on purpose
 * and is not touched by this.
 *
 * The thousands group is what makes it a price. A bare run of digits is a
 * volume or a duration — «1ماهه-100گیگ» must not lose its size — so this only
 * takes a number that is grouped («200.000», «1.300.000»), optionally followed
 * by «ت» or «تومان».
 */
export function planDisplayName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.replace(/[-–—\s]*\d{1,3}(?:\.\d{3})+\s*(?:ت|تومان)?\s*$/u, '');
  // A name that is nothing BUT its price keeps its price — «250.000» alone is
  // still more use to an operator than an empty cell.
  return trimmed.trim() === '' ? name : trimmed.trim();
}

/**
 * A sale's status and a service's status, in the panel's own words — and the
 * colour that goes with either.
 *
 * Here for the reason `STATUS_FA` above is here: a second screen reads them.
 * The customer's card lists that customer's own orders and services, and a
 * private copy on that page is how «تکمیل شده» and «انجام شد» end up on two
 * screens describing one column.
 *
 * Indexed by string so a status this build has never heard of falls through to
 * itself rather than rendering «undefined».
 */
export const ORDER_STATUS_FA: Record<string, string> = {
  DRAFT: 'پیش‌نویس',
  AWAITING_PAYMENT: 'در انتظار پرداخت',
  PAID: 'پرداخت شده',
  PROVISIONING: 'در حال تحویل',
  COMPLETED: 'تکمیل شده',
  FAILED: 'ناموفق',
  CANCELLED: 'لغو شده',
  EXPIRED: 'منقضی',
};

export const SUB_STATUS_FA: Record<string, string> = {
  ACTIVE: 'فعال',
  PENDING_PAYMENT: 'در انتظار پرداخت',
  ON_HOLD: 'در انتظار اتصال',
  DISABLED: 'غیرفعال',
  REMOVED: 'حذف شده',
  FAILED: 'ناموفق',
};

/** Green for a good end state, red for a bad one, plain for in-flight. */
export function statusTone(status: string): string {
  if (['COMPLETED', 'ACTIVE', 'PAID'].includes(status)) return 'badge badge-active';
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REMOVED', 'DISABLED'].includes(status)) {
    return 'badge badge-block';
  }
  return 'badge badge-info';
}
