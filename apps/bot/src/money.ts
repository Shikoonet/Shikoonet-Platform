/**
 * The Toman edge.
 *
 * Everywhere else in the platform money is integer IRR. Customers think in
 * Toman, and this is the only file allowed to know that — one conversion, in
 * one direction, with a test.
 *
 * The other half of the money path is the standing per-customer discount
 * (`users.discount_percent`, legacy `user.pricediscount`). It is live: eight
 * production customers carry 10, 15, 20, 30 and 100 percent. A checkout that
 * ignored it would overcharge every one of them, so it is applied here rather
 * than left to whoever writes the next handler.
 */

export const IRR_PER_TOMAN = 10;

/**
 * `1950000` -> `'195,000 تومان'`.
 *
 * Grouped with Latin digits and commas because that is what the PHP bot's
 * `number_format` produces and what these customers already read on their
 * buttons today. Rounds rather than throws: a price that is not a whole number
 * of Toman is a catalog data error, and refusing to render it would take the
 * whole menu down instead of one row.
 */
export function formatToman(priceIrr: number): string {
  const toman = Math.round(priceIrr / IRR_PER_TOMAN);
  return `${toman.toLocaleString('en-US')} تومان`;
}

/** ۱۹۵ -> 195. Persian and Arabic-Indic digits both appear in these names. */
function toAsciiDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/**
 * Does this product's own name already quote this price?
 *
 * Every migrated product has the price typed into its name — '1ماهه-50گیگ-چند
 * کاربر-195.000ت' — because the legacy schema had nowhere else to show it. Seen
 * on the live bot on 2026-08-12: appending our own price to that name makes the
 * button say 195,000 twice.
 *
 * Digits are normalised and thousands separators between digits are dropped, so
 * '195.000' matches 195000. The comparison is against whole digit runs: a name
 * mentioning 1,000,000 does not count as mentioning 100,000.
 */
export function nameMentionsPrice(name: string, priceIrr: number): boolean {
  const amount = Math.round(priceIrr / IRR_PER_TOMAN);
  // Below a thousand Toman there is no real price, and every small number in
  // these names is a volume, a duration or a user count. Matching one of those
  // would drop the price off a button that needs it.
  if (amount < 1000) return false;
  const toman = String(amount);
  const runs = toAsciiDigits(name)
    .replace(/(?<=\d)[.,٫٬،\s](?=\d)/g, '')
    .match(/\d+/g);
  return runs !== null && runs.includes(toman);
}

export interface Price {
  /** The catalog's list price, before anything is taken off. */
  unitPriceIrr: number;
  /** What the standing discount is worth, in IRR. Zero for most customers. */
  discountIrr: number;
  /** What the customer actually owes. */
  totalIrr: number;
}

/**
 * Applies the customer's standing discount to a list price.
 *
 * The three numbers are returned separately because `orders` stores them
 * separately and has a CHECK that ties them together
 * (`total = unit * quantity - discount`). Keeping the list price on the row is
 * what makes a discounted sale auditable later.
 *
 * The discount is floored to a whole Toman so the total never becomes a price
 * no customer could pay, and floored rather than rounded so it can never exceed
 * the percentage actually granted.
 */
export function priceForUser(listPriceIrr: number, discountPercent: number): Price {
  if (!Number.isFinite(listPriceIrr) || listPriceIrr < 0) {
    throw new Error(`list price ${listPriceIrr} is not a usable amount`);
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error(`discount ${discountPercent} is outside 0..100`);
  }
  const rawIrr = (listPriceIrr * discountPercent) / 100;
  const discountIrr = Math.floor(rawIrr / IRR_PER_TOMAN) * IRR_PER_TOMAN;
  return {
    unitPriceIrr: listPriceIrr,
    discountIrr,
    totalIrr: listPriceIrr - discountIrr,
  };
}
