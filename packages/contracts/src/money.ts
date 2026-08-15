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
