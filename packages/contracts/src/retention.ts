/**
 * «یادآوری تمدید» — the rules an operator writes to keep a customer.
 *
 * Sam, 2026-09-20. First buyers came in on a ~100k starter; the real service
 * is 300–400k, and the moment that decides whether they stay is the week
 * around their first expiry. A rule says: to the customers of THIS panel, who
 * have only this one service, N days before (or after) it ends, send THIS text
 * — with a discount code made on «کدهای تخفیف».
 *
 * ## Why one settings row and not a table
 *
 * The list is small (a shop writes a handful), it is edited whole on one
 * screen, and the bot reads it once a cycle. That is the shape of
 * `('shop','review_messages')` — a JSON array in `settings` — and a table
 * would be a schema for a dropdown. The validator below is shared by the panel
 * (to refuse a body) and the bot (to read the row), so the panel cannot store
 * what the bot cannot read.
 *
 * ## The offer is a discount code, not a field here
 *
 * `discount_codes` already says everything the offer needs: percent, amount,
 * bonus gigabytes, renew-only, pinned to a panel, capped, dated, once per
 * customer — and the last one is a unique index, not code. The rule only
 * points at a code and prints it. Who is TOLD is the rule's decision; who may
 * USE it is the code's.
 */

export const RETENTION_RULES = { scope: 'bot', key: 'retention_rules' } as const;

export interface RetentionRule {
  /** Minted once by the screen, never renamed: it is inside every dedupe key. */
  key: string;
  /** For the operator and the group report. */
  name: string;
  enabled: boolean;
  /**
   * `provisioning_providers.id`, or null.
   *
   * The audience was the provider row until 2026-09-20; Sam: «دسته‌بندی بر
   * اساس یوزرنیم پنل‌ها باشه» — the panel admin who made the account is the
   * line, because the import gave every legacy account the same row. Rules
   * saved before that day still carry this and still work; a new rule sets
   * `panelAdmin` and leaves this null. At least one of the two is required.
   */
  providerId: number | null;
  /** `subscriptions.panel_admin` — the panel admin that owns the account (0085). */
  panelAdmin: string | null;
  /** Fires this many days before expiry. 0 = not before. */
  daysBefore: number;
  /** And this many days after. 0 = not after. */
  daysAfter: number;
  /** «فقط مشتری‌هایی که یک سرویس دارند (به‌جز تست)». */
  onlyService: boolean;
  /** `discount_codes.id` printed as `{code}`, or null for a plain message. */
  codeId: number | null;
  /** The message before expiry. Placeholders: {days} {service} {username} {code} {discount} {renewButton}. */
  text: string;
  /**
   * The message after expiry, for the «days after» side of the window.
   *
   * Its own text because «{days} روز دیگر تمام می‌شود» is a lie to somebody
   * whose service ended on Tuesday. Empty means «use `text`», which is what
   * every rule saved before this field existed does.
   */
  textAfter: string;
  /**
   * The Tehran clock time the rule sends at, «HH:MM», or null.
   *
   * Sam, 2026-09-20: «از اون به بعد همیشه همون موقع پیغام بده». With a time,
   * the day's message goes at the first sweep after that minute, and only to
   * services already inside the window at that minute — one who enters it
   * later in the day waits for tomorrow's slot, so a «one day before» rule
   * is one message and not two. Null is every rule saved before the field
   * existed: sent on entering the window, then every 24 hours.
   */
  sendAt: string | null;
}

export const RETENTION_PLACEHOLDERS = ['days', 'service', 'username', 'code', 'discount', 'renewButton'] as const;

/**
 * What a new rule says until the operator changes it. Sam's own wording,
 * 2026-09-20, with the percentage lifted out into `{discount}` so a rule
 * pointed at a 40% code does not keep saying 30. The code sits on a line of
 * its own because that is the line a thumb lands on.
 */
export const RETENTION_DEFAULT_TEXT =
  'سرویس «{service}» شما {days} روز دیگر تمام می‌شود.\n\nبا کد زیر می‌توانید از {discount} تخفیف برای تمدید سرویستان استفاده کنید:\n{code}\n\nبرای تمدید روی دکمهٔ «{renewButton}» بزنید.';
export const RETENTION_DEFAULT_TEXT_AFTER =
  'سرویس «{service}» شما {days} روز پیش تمام شد.\n\nهنوز می‌توانید با کد زیر از {discount} تخفیف برای تمدید استفاده کنید:\n{code}\n\nبرای تمدید روی دکمهٔ «{renewButton}» بزنید.';

/** «۳۰٪», «۵۰٬۰۰۰ تومان», «۱۰ گیگ حجم اضافه» — the offer in the operator's words. */
export function discountLabel(code: {
  kind: string;
  percent: number | null;
  amountIrr: number | null;
  bonusGb: number | null;
}): string {
  const pct = code.percent === null ? '' : `${Number(code.percent).toLocaleString('en-US')}٪`;
  const toman = code.amountIrr === null ? '' : `${Math.round(code.amountIrr / 10).toLocaleString('en-US')} تومان`;
  switch (code.kind) {
    case 'PERCENT_OFF':
      return pct;
    case 'AMOUNT_OFF':
      return toman;
    case 'GIFT_BALANCE':
      return `${toman} شارژ کیف پول`;
    case 'BONUS_GB':
      return `${Number(code.bonusGb ?? 0).toLocaleString('en-US')} گیگ حجم اضافه`;
    case 'BONUS_PERCENT':
      return `${pct} حجم اضافه`;
    default:
      return pct || toman;
  }
}

export const RETENTION_LIMITS = {
  rules: 20,
  name: 60,
  text: 1000,
  daysBefore: 365,
  daysAfter: 90,
} as const;

const KEY = /^[a-z0-9_-]{1,40}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A panel admin username as PasarGuard allows them: no whitespace, sane length. */
const ADMIN = /^\S{1,64}$/;
const MENTIONS_CODE = /\{(?:code|discount)\}/;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

/**
 * The stored value as a list of rules, or null when it is not one.
 *
 * Null rather than «the good ones»: a list with one bad rule is a list the
 * screen wrote wrong, and half-obeying it would send half the messages while
 * the screen shows all of them. The panel refuses the body with 400 on null;
 * the bot treats null as «no rules» and logs it.
 */
export function parseRetentionRules(value: unknown): RetentionRule[] | null {
  if (!Array.isArray(value) || value.length > RETENTION_LIMITS.rules) return null;
  const out: RetentionRule[] = [];
  const keys = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r['key'] !== 'string' || !KEY.test(r['key']) || keys.has(r['key'])) return null;
    if (typeof r['name'] !== 'string' || r['name'].trim().length === 0 || r['name'].length > RETENTION_LIMITS.name) return null;
    if (typeof r['enabled'] !== 'boolean' || typeof r['onlyService'] !== 'boolean') return null;
    const providerId = r['providerId'] === undefined ? null : r['providerId'];
    if (providerId !== null && !isInt(providerId, 1, Number.MAX_SAFE_INTEGER)) return null;
    const panelAdmin = r['panelAdmin'] === undefined ? null : r['panelAdmin'];
    if (panelAdmin !== null && (typeof panelAdmin !== 'string' || !ADMIN.test(panelAdmin))) return null;
    // No audience at all is not a rule.
    if (providerId === null && panelAdmin === null) return null;
    if (!isInt(r['daysBefore'], 0, RETENTION_LIMITS.daysBefore)) return null;
    if (!isInt(r['daysAfter'], 0, RETENTION_LIMITS.daysAfter)) return null;
    // A window of nothing is a rule that can never fire, which the operator
    // would read as «broken» rather than «zero».
    if (r['daysBefore'] === 0 && r['daysAfter'] === 0) return null;
    if (r['codeId'] !== null && !isInt(r['codeId'], 1, Number.MAX_SAFE_INTEGER)) return null;
    if (typeof r['text'] !== 'string' || r['text'].trim().length === 0 || r['text'].length > RETENTION_LIMITS.text) return null;
    // Optional and absent on every rule saved before 2026-09-20.
    const textAfter = r['textAfter'] === undefined ? '' : r['textAfter'];
    if (typeof textAfter !== 'string' || textAfter.length > RETENTION_LIMITS.text) return null;
    // Optional too; absent or blank is «on entering the window».
    const sendAt = r['sendAt'] === undefined || r['sendAt'] === '' ? null : r['sendAt'];
    if (sendAt !== null && (typeof sendAt !== 'string' || !CLOCK.test(sendAt))) return null;
    // A text that promises a code needs one. The default text does, so a
    // rule saved without picking a code would send «با کد  از  تخفیف» — two
    // blanks where the offer was. Only an ENABLED rule is held to this: a
    // draft the operator has not finished may be saved off and finished later.
    if (r['enabled'] && r['codeId'] === null && MENTIONS_CODE.test(`${r['text']}\n${textAfter}`)) return null;
    keys.add(r['key']);
    out.push({
      key: r['key'],
      name: r['name'].trim(),
      enabled: r['enabled'],
      providerId,
      panelAdmin,
      daysBefore: r['daysBefore'],
      daysAfter: r['daysAfter'],
      onlyService: r['onlyService'],
      codeId: r['codeId'] as number | null,
      text: r['text'],
      textAfter: textAfter.trim() === '' ? '' : textAfter,
      sendAt,
    });
  }
  return out;
}

/**
 * The customer's message. An unknown `{slot}` stays literal — the same rule
 * `Texts.render` follows — so a typo is visible in the group report rather
 * than silently blank.
 */
export function renderRetentionText(
  text: string,
  values: Record<(typeof RETENTION_PLACEHOLDERS)[number], string>,
): string {
  return text.replace(/\{([a-zA-Z]+)\}/g, (whole, slot: string) =>
    slot in values ? values[slot as keyof typeof values] : whole,
  );
}

/**
 * The outbox key for one rule, one service, one expiry, one DAY of the window.
 *
 * `dayIndex` is whole days to expiry: +3 is three days before, −2 is two
 * days after. It moves once a day, so a service inside a five-day window is
 * written five times, a day apart — Sam, 2026-09-20: «روزی یک بار» — and a
 * renewal moves the expiry, which starts the count again. Until that day
 * the key had no day part and a service heard from a rule once per expiry.
 */
export function retentionDedupeKey(
  ruleKey: string,
  subscriptionId: number,
  expiresEpoch: number,
  dayIndex: number,
): string {
  return `retention:${ruleKey}:${subscriptionId}:${expiresEpoch}:${dayIndex}`;
}
