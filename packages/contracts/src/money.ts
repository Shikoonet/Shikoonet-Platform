/**
 * The one ceiling every hand-typed money field in the panel is checked against.
 *
 * Three routes declared this number separately — `PLAN_MAX_PRICE_IRR`,
 * `CODE_MAX_IRR`, `ADJUST_MAX_IRR` — each with a comment saying it was the
 * admin's own card-to-card ceiling, and each free to drift from the other two
 * and from the shop. One name, one value, one place to check it against the
 * shop's own setting.
 *
 * It is not an arbitrary round number. `PaySetting.maxbalancecart` in the
 * production database is 10,000,000 Toman — the most a single card-to-card
 * transfer may settle — and `packages/migrate/test/catalog-ceiling.mysql.test.ts`
 * asserts this constant against that row rather than against itself. A plan, a
 * gift code, or a wallet correction priced above what one payment can settle is
 * not a price, it is a typo with an extra zero.
 *
 * For scale: the priciest thing this shop has ever sold is 750,000 Toman, so
 * the ceiling sits at roughly 13× the real catalogue. That ratio is asserted
 * too — a ceiling raised until it stops catching typos should go red.
 */
export const MAX_SINGLE_PAYMENT_IRR = 100_000_000;

/**
 * Every amount a customer can be asked to transfer is a whole number of
 * Toman — ten Rials. Auto-verify compares the bank's figure against ours
 * exactly, so a price of 1,950,005 IRR (195,000.5 Toman) is one no transfer
 * can ever equal, and every purchase at it would go to manual review for
 * ever. Until 2026-09-12 this held only because every writer happened to
 * multiply by ten (issue #195); a zod `.refine` at each hand-typed money
 * field is where it is checked now.
 */
export const IRR_PER_TOMAN = 10;
export function isWholeToman(irr: number): boolean {
  return Number.isInteger(irr) && irr % IRR_PER_TOMAN === 0;
}
export const NOT_WHOLE_TOMAN = 'a price must be a whole number of Toman';
