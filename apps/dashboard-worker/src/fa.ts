/**
 * Persian digits for the sentences this server writes.
 *
 * Most numbers on the panel never come near here: the server sends a number,
 * the SPA formats it, and `apps/admin-web/src/format.ts` is where the rule
 * lives. But a few refusals are written as a whole sentence on this side —
 * "12 orders and 7 sold services are attached to this row" — because only the
 * server knows what it counted, and those went out with Latin digits.
 *
 * That is not a small thing on a right-to-left screen. Found on 2026-08-22 by
 * pressing «حذف پلن» in a browser: the refusal said «12 سفارش» directly under a
 * paragraph on the same screen saying «۱۲ سفارش» — the same number, twice, in
 * two alphabets. No test saw it, because every test asserted the sentence
 * against a string built the same way.
 *
 * One module rather than an `Intl` call per sentence, so the next refusal
 * written here has somewhere obvious to reach for. `fa-IR` and not a digit map:
 * grouping separators and the decimal mark have to agree with the rest of the
 * panel, and `Intl` is the thing that already decides those.
 */

const FA = new Intl.NumberFormat('fa-IR');

/** A count, in the digits the rest of the panel uses. */
export function faNum(n: number): string {
  return FA.format(n);
}
