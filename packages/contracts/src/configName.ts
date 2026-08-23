/**
 * The name a customer reads on a config button, composed from what it is.
 *
 * ## Why this is a function and not a text box
 *
 * The legacy shop had no columns for volume or duration on the thing it sold —
 * `product.name_product` was one hand-typed string, price included:
 * «1ماهه-20گیگ-چند کاربر-119.000ت». Every price change meant editing prose in
 * every row, and every operator typed the separators slightly differently.
 *
 * We do have the columns. So the name is composed from them and left editable:
 * an operator who wants «✨تانل اختصاصی✨» still types it, and one who wants the
 * ordinary thing gets it without typing.
 *
 * ## The price is deliberately absent
 *
 * `priced()` in the bot appends the live price to the button unless the name
 * already quotes it (`nameMentionsPrice`, apps/bot/src/money.ts). Baking a
 * price into the name is what made the legacy bot show one number on the button
 * and charge another at checkout for the eight customers who carry a standing
 * discount. A name with no price in it can never disagree with the till.
 *
 * `apps/bot/test/config-name.test.ts` asserts that against the bot's own
 * renderer rather than against a rule restated here.
 */

const FA = new Intl.NumberFormat('fa-IR');

/** What a config is, in the three fields `product_plans` actually stores. */
export interface ConfigShape {
  /** Gigabytes, or null for unmetered. Zero is a real (free) volume, not null. */
  volumeGb: number | null;
  /** Days, or null for no expiry. */
  durationDays: number | null;
  /** Simultaneous devices, or null for no ceiling. */
  userLimit: number | null;
}

/** A month is 30 days here, the same as everywhere else in the catalogue. */
const DAYS_PER_MONTH = 30;

function duration(days: number | null): string {
  if (days === null) return 'بدون انقضا';
  if (days > 0 && days % DAYS_PER_MONTH === 0) {
    return `${FA.format(days / DAYS_PER_MONTH)} ماهه`;
  }
  return `${FA.format(days)} روزه`;
}

function volume(gb: number | null): string {
  if (gb === null) return 'نامحدود';
  return `${FA.format(gb)} گیگ`;
}

function users(limit: number | null): string {
  if (limit === null) return 'چند کاربر';
  if (limit === 1) return 'تک کاربر';
  return `${FA.format(limit)} کاربر`;
}

/**
 * «۱ ماهه - ۲۰ گیگ - چند کاربر»
 *
 * The order is the legacy's, because these customers have been reading it for
 * years: how long, then how much, then how many.
 */
export function configName(shape: ConfigShape): string {
  return [duration(shape.durationDays), volume(shape.volumeGb), users(shape.userLimit)].join(
    ' - ',
  );
}
