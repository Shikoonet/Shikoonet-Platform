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
  /** `provisioning_providers.id` — the panel row as the dashboard lists it. */
  providerId: number;
  /** Fires this many days before expiry. 0 = not before. */
  daysBefore: number;
  /** And this many days after. 0 = not after. */
  daysAfter: number;
  /** «فقط مشتری‌هایی که یک سرویس دارند (به‌جز تست)». */
  onlyService: boolean;
  /** `discount_codes.id` printed as `{code}`, or null for a plain message. */
  codeId: number | null;
  /** The message. Placeholders: {days} {service} {username} {code} {renewButton}. */
  text: string;
}

export const RETENTION_PLACEHOLDERS = ['days', 'service', 'username', 'code', 'renewButton'] as const;

export const RETENTION_LIMITS = {
  rules: 20,
  name: 60,
  text: 1000,
  daysBefore: 365,
  daysAfter: 90,
} as const;

const KEY = /^[a-z0-9_-]{1,40}$/;

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
    if (!isInt(r['providerId'], 1, Number.MAX_SAFE_INTEGER)) return null;
    if (!isInt(r['daysBefore'], 0, RETENTION_LIMITS.daysBefore)) return null;
    if (!isInt(r['daysAfter'], 0, RETENTION_LIMITS.daysAfter)) return null;
    // A window of nothing is a rule that can never fire, which the operator
    // would read as «broken» rather than «zero».
    if (r['daysBefore'] === 0 && r['daysAfter'] === 0) return null;
    if (r['codeId'] !== null && !isInt(r['codeId'], 1, Number.MAX_SAFE_INTEGER)) return null;
    if (typeof r['text'] !== 'string' || r['text'].trim().length === 0 || r['text'].length > RETENTION_LIMITS.text) return null;
    keys.add(r['key']);
    out.push({
      key: r['key'],
      name: r['name'].trim(),
      enabled: r['enabled'],
      providerId: r['providerId'],
      daysBefore: r['daysBefore'],
      daysAfter: r['daysAfter'],
      onlyService: r['onlyService'],
      codeId: r['codeId'] as number | null,
      text: r['text'],
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

/** The outbox key for one rule, one service, one expiry. */
export function retentionDedupeKey(ruleKey: string, subscriptionId: number, expiresEpoch: number): string {
  return `retention:${ruleKey}:${subscriptionId}:${expiresEpoch}`;
}
