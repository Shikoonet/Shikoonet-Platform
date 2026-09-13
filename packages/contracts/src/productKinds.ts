/**
 * What kind of thing a service sells, and which config fields that kind has.
 *
 * Sam, 2026-09-13: «vpn حجم و زمان و تعداد کاربر می‌گیرد ولی spotify حجم
 * استفاده ندارد». Until then the config form asked for all three whatever the
 * service was, and the API accepted all three: a Spotify config could carry
 * fifty gigabytes that meant nothing anywhere.
 *
 * ONE table, read by three places that used to disagree by construction: the
 * form (which fields to draw), the API (which fields to refuse — the trust
 * boundary, so the form is not the only thing standing between a typo and
 * the database), and `configName` (which parts to compose the name from).
 *
 * Panel groups are deliberately NOT here. They are gated by whether the
 * PANEL is automated (`hasGroups`), not by the product's kind — a second gate
 * on the same fact would drift from the first.
 */

/** The `kind` values `products.kind`'s CHECK constraint allows (0002_catalog). */
export const PRODUCT_KINDS = ['vpn', 'ai_account', 'spotify', 'manual', 'other'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_KIND_FA: Record<ProductKind, string> = {
  vpn: 'VPN',
  ai_account: 'اکانت هوش مصنوعی',
  spotify: 'اسپاتیفای',
  manual: 'تحویل دستی',
  other: 'سایر',
};

/** The three fields `product_plans` stores that a kind may or may not have. */
export type ConfigField = 'volumeGb' | 'durationDays' | 'userLimit';

/**
 * The fields each kind has, in the order the form draws them.
 *
 * `userLimit` on Spotify is the seat count of a family plan. `manual` and
 * `other` keep all three because nobody knows what a hand-delivered thing is
 * measured in — an operator who does not need a field leaves it empty.
 */
export const PRODUCT_KIND_FIELDS: Record<ProductKind, readonly ConfigField[]> = {
  vpn: ['durationDays', 'volumeGb', 'userLimit'],
  spotify: ['durationDays', 'userLimit'],
  ai_account: ['durationDays'],
  manual: ['durationDays', 'volumeGb', 'userLimit'],
  other: ['durationDays', 'volumeGb', 'userLimit'],
};

const ALL_FIELDS: readonly ConfigField[] = ['volumeGb', 'durationDays', 'userLimit'];

export function isProductKind(kind: string): kind is ProductKind {
  return (PRODUCT_KINDS as readonly string[]).includes(kind);
}

/**
 * The fields in `body` that this kind does not have — present AND set.
 *
 * Present-and-null is not an error: it is how a legacy row that carries a
 * field the kind has since lost gets that field cleared. And a key that is
 * simply absent says nothing, so a repricing of such a row never has to
 * mention the field it is not about. An unknown kind refuses nothing; the
 * CHECK constraint is what refuses the kind.
 */
export function fieldsNotForKind(
  kind: string,
  body: Partial<Record<ConfigField, unknown>>,
): ConfigField[] {
  if (!isProductKind(kind)) return [];
  const has = PRODUCT_KIND_FIELDS[kind];
  return ALL_FIELDS.filter((f) => !has.includes(f) && body[f] !== undefined && body[f] !== null);
}
