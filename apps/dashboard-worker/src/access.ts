/**
 * Who may read what, once they are signed in.
 *
 * This file used to verify Cloudflare Access JWTs. Access is gone — Sam's
 * decision, 2026-08-16 — and the login that replaced it lives in
 * `operatorSession.ts`. What stays here is the part Access never did: the role
 * a signed-in operator has, and the line between running the shop and reading
 * about its customers.
 *
 * That line matters more now, not less. There used to be two Cloudflare Access
 * applications with two audiences, so a payment operator's token simply did not
 * verify against the admin panel — the boundary was a signature. With one door,
 * `mayRead` and the per-route ADMIN checks are the whole of it.
 */

import type { AccessRole, SectionId, SectionPerms } from '@shikoo/contracts';

/**
 * What a READ_ONLY operator may not read on the admin surface.
 *
 * Every write route on this surface is behind `role !== 'ADMIN'` — and that is
 * now checked rather than asserted. `write-roles.test.ts` enumerates
 * `app.routes` and asks each of the 114 write routes what it tells a
 * READ_ONLY and a REVIEWER, so a route added tomorrow without a guard fails
 * there instead of shipping. This sentence stood here for months meaning
 * nothing, in a repository that has already been bitten twice by a comment
 * explaining why something was safe.
 *
 * Two exceptions live in that test with their reasons: previewing a bulk
 * price change is open to any operator while applying one is ADMIN, and five
 * POSTs on the payments hub are reads that happen to take a body — a parser
 * sample, a card test, an assignment preview. None of them writes.
 *
 * Every *read* route was behind nothing at all: a READ_ONLY row could open a named
 * customer, their phone number, their wallet ledger and every order they have
 * ever placed. The only thing separating the roles was the audit trail, and a
 * record is not a guard — the same sentence the bot's admin panel earned.
 *
 * The line drawn here is the shop's operations versus its customers: the
 * catalogue, the panels, the bot's wording and the aggregate overview are
 * readable by anyone signed in, and anything that names a person is not. Moving
 * a path across that line is one entry in this list.
 *
 * Prefix-matched rather than checked per route, so a route added under
 * `/customers/` tomorrow is covered without anybody remembering.
 */
const PERSONAL_DATA_PREFIXES = [
  '/api/v1/admin/customers',
  // A list of customers by another name: who brought whom.
  '/api/v1/admin/referrers',
  '/api/v1/admin/orders',
  '/api/v1/admin/subscriptions',
  '/api/v1/admin/wallet-entries',
  '/api/v1/admin/reseller-requests',
  // Who may operate the shop is not an operations detail.
  '/api/v1/admin/access-users',
  '/api/v1/admin/access-groups',
  '/api/v1/admin/bot-admins',
  // Nor is what the shop spends. Not personal data — the other reason a path is
  // on this list — but the same answer: `nav.ts` does not draw «هزینه‌ها و
  // تعدیل‌ها» for a READ_ONLY operator, and a section hidden in the sidebar
  // while the API still answers is decoration rather than a boundary.
  '/api/v1/admin/revenue-adjustments',
  // The books themselves — statements, the off-books list, the fresh start.
  // Same reason as the ledger above: what the shop's accounts hold and how
  // the money moved is the owner's to read.
  '/api/v1/admin/books',
  // What the software noticed. Not personal data either, and on the list for
  // the third reason: an event carries a stack trace and a `ref` that names an
  // order, and reading the shop's faults is the owner's job rather than a
  // payment reviewer's. `eventRoutes.ts` checks ADMIN again per route — this
  // entry is what keeps «رویدادها» out of a reader's sidebar in the first
  // place.
  '/api/v1/admin/events',
  // Importing the legacy shop is the owner's job, and a run's report names the
  // dump on disk and carries sample rows out of `users` and `payments`. Every
  // route under it checks ADMIN again; this entry is what keeps «ایمپورت» out
  // of a reader's sidebar to begin with.
  '/api/v1/admin/import',
];

/**
 * Whether this role may read this path.
 *
 * Pure, and exported, so the rule can be asserted directly rather than only
 * through fifteen route tests that would each have to remember to exist.
 */
export function mayRead(path: string, role: AccessRole): boolean {
  if (role !== 'READ_ONLY') return true;
  if (PERSONAL_DATA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  // The discount codes themselves are catalogue; who redeemed one is a name.
  return !path.endsWith('/redemptions');
}

/**
 * Where each API route lives, for an operator in a custom group (issue #363).
 *
 * `[prefix, editors, ...viewers]`, matched against the ROUTE PATTERN Hono
 * dispatched to (`/api/v1/admin/products/:id`), never the raw path: a pattern
 * is what `write-roles.test.ts` enumerates, it cannot be spelled two ways, and
 * `DELETE /accounts/analyze` is `DELETE /accounts/:id` here rather than a
 * lookalike of the view-only `POST /accounts/analyze`. Longest prefix wins, on
 * a `/` boundary — `/admin/bot` is not `/admin/bot-admins`.
 *
 * `editors` may write and every section in the entry may read. `'*'` is
 * «anybody signed in». A route no entry covers is refused: a page added
 * tomorrow is closed to custom groups until somebody places it here, and
 * `access-groups.test.ts` fails until they do.
 *
 * The built-in groups never come through here — see `customGroupRole`.
 */
type Section = SectionId | '*';
const SECTIONS: [string, Section | Section[], ...Section[]][] = [
  // Every page draws these: who am I, which build, the sidebar badges, the
  // bell. The bell's markers are per viewer.
  ['/api/v1/admin/me', '*'],
  ['/api/v1/version', '*'],
  ['/api/v1/admin/attention', '*'],
  ['/api/v1/notifications', '*'],
  // …but not its feed: every bank credit with the account's balance.
  ['/api/v1/notifications/recent', 'payments'],
  // The banner on every page reads it; turning it on or off is a setting.
  ['/api/v1/continuity-mode', 'settings', '*'],

  // Payment hub.
  ['/api/v1/today', 'today'],
  ['/api/v1/devices', 'devices'],
  // The account picker of five pages.
  ['/api/v1/accounts', 'accounts', 'payments', 'books', 'expenses', 'profit'],
  ['/api/v1/payment-cards', 'accounts'],
  ['/api/v1/banks', 'banks'],
  ['/api/v1/admin/sms', 'banks'],
  ['/api/v1/analytics', 'payments'],
  ['/api/v1/cards', 'payments'],
  ['/api/v1/payments', 'payments'],
  ['/api/v1/payment-claims', 'payments'],
  ['/api/v1/suspects', 'payments'],
  // Bank transactions, the payments screen's — not the «تراکنش‌ها» page,
  // which is the wallet ledger below.
  ['/api/v1/transactions', 'payments', 'books'],
  ['/api/v1/resellers', 'payments'],
  ['/api/v1/review-messages', 'payments'],
  ['/api/v1/matches', 'payments'],
  ['/api/v1/match', 'payments'],
  ['/api/v1/comments', 'payments'],
  ['/api/v1/comment', 'payments'],
  ['/api/v1/orders', 'orders'],

  // Admin surface.
  ['/api/v1/admin/overview', 'dashboard'],
  ['/api/v1/admin/stats', 'stats'],
  ['/api/v1/admin/customers', 'customers', 'stats', 'payments', 'referrals'],
  ['/api/v1/admin/renewals', 'customers'],
  ['/api/v1/admin/referrers', 'referrals'],
  ['/api/v1/admin/orders', 'orders', 'customers'],
  ['/api/v1/admin/subscriptions', 'subscriptions', 'customers'],
  ['/api/v1/admin/wallet-entries', 'transactions'],
  ['/api/v1/admin/reseller-requests', 'requests'],
  ['/api/v1/admin/reseller-tiers', 'requests'],
  ['/api/v1/admin/resellers', 'resellers'],
  ['/api/v1/admin/bulk', 'bulk'],
  // The progress bar every page draws while a broadcast runs.
  ['/api/v1/admin/bulk/recent', 'bulk', '*'],
  ['/api/v1/admin/panels', 'panels', 'bulk', 'catalog'],
  // Only the catalogue page calls these.
  ['/api/v1/admin/panels/:id/panel-groups', 'catalog', 'panels'],
  ['/api/v1/admin/panels/:id/inbounds', 'catalog', 'panels'],
  ['/api/v1/admin/catalog', 'catalog', 'categories', 'discounts'],
  ['/api/v1/admin/catalog-layout', ['catalog', 'categories']],
  ['/api/v1/admin/products', 'catalog', 'stock', 'categories'],
  ['/api/v1/admin/product-categories', 'categories', 'catalog', 'stock'],
  ['/api/v1/admin/discounts', 'discounts'],
  ['/api/v1/admin/stock', 'stock'],
  ['/api/v1/admin/revenue-adjustments', 'expenses', 'stats', 'profit'],
  ['/api/v1/admin/revenue-adjustments/parties', 'parties', 'expenses'],
  ['/api/v1/admin/revenue-adjustments/profit', 'profit'],
  ['/api/v1/admin/revenue-adjustments/distributions', 'profit'],
  ['/api/v1/admin/books', 'books'],
  ['/api/v1/admin/settings', 'settings'],
  ['/api/v1/admin/cleanup-debits', 'settings'],
  // Drawn on both pages by one component.
  ['/api/v1/admin/required-channels', ['content', 'settings']],
  ['/api/v1/admin/bot', 'bot', 'content', 'settings'],
  ['/api/v1/admin/bot-texts', 'texts'],
  ['/api/v1/admin/bot-custom-emoji', 'texts'],
  ['/api/v1/admin/emoji-packs', 'texts', 'catalog', 'categories'],
  ['/api/v1/admin/bot-keyboard', 'keyboard'],
  // The payments screen edits its own review templates in place.
  ['/api/v1/admin/review-messages', ['texts', 'payments']],
  ['/api/v1/admin/help-articles', 'content'],
  ['/api/v1/admin/client-apps', 'content'],
  ['/api/v1/admin/cron', 'cron'],
  ['/api/v1/admin/retention', 'retention'],
  ['/api/v1/admin/access-users', 'access'],
  ['/api/v1/admin/access-groups', 'access'],
  ['/api/v1/admin/bot-admins', 'access'],
  ['/api/v1/admin/events', 'events'],
  ['/api/v1/admin/import', 'import'],
];

/**
 * A write one page makes into another page's entry. Exact route, so the
 * categories page may save a product's badge without also being able to
 * delete the product.
 */
export const ALSO_EDITED_BY: ReadonlyMap<string, SectionId[]> = new Map([
  ['POST /api/v1/admin/customers/:id/status', ['payments']],
  ['POST /api/v1/admin/products/:id', ['categories']],
  ['POST /api/v1/admin/products/plans/:id', ['stock']],
  ['POST /api/v1/admin/product-categories', ['catalog']],
  ['POST /api/v1/admin/revenue-adjustments', ['profit']],
  ['POST /api/v1/transactions/:transactionId/decline-income', ['books']],
  ['POST /api/v1/transactions/:transactionId/restore-income', ['books']],
]);

/**
 * Writes by method that change nothing, or only what this viewer has seen —
 * the same list `write-roles.test.ts` lets a READ_ONLY operator call.
 */
export const VIEW_POSTS: ReadonlySet<string> = new Set([
  'POST /api/v1/notifications/mark-all-read',
  'POST /api/v1/notifications/mark-read',
  'POST /api/v1/notifications/transactions/:transactionId/seen',
  'POST /api/v1/payments/events/:eventKey/seen',
  'POST /api/v1/payments/tabs/read-all',
  'POST /api/v1/accounts/analyze',
  'POST /api/v1/accounts/:accountId/backfill-preview',
  'POST /api/v1/banks/test-card',
  'POST /api/v1/banks/test-sms',
  'POST /api/v1/admin/bulk/price/preview',
]);

/** The entry that covers a route pattern, or undefined. Exported for the test. */
export function sectionEntry(pattern: string) {
  let best: (typeof SECTIONS)[number] | undefined;
  for (const e of SECTIONS) {
    const p = e[0];
    if ((pattern === p || pattern.startsWith(`${p}/`)) && (!best || p.length > best[0].length)) {
      best = e;
    }
  }
  return best;
}

/**
 * What a custom group may do on one route: `null` to refuse it, otherwise the
 * role the route's own checks should see.
 *
 * Returning a role rather than a boolean is what keeps this change small and
 * the old checks working. Some 190 handlers still ask `role !== 'ADMIN'` or
 * `role === 'READ_ONLY'`, and several do more than refuse — mask a column,
 * withhold a CSV export, gate a preview. For a custom group they now see
 * ADMIN on a section it may edit and REVIEWER on one it may only read, so a
 * reader of «سفارشات» gets the page without its export, exactly as a REVIEWER
 * did. A write is decided here and nowhere else: without edit on the route's
 * section it never reaches its handler.
 *
 * Deliberately wide: edit on «پرداخت‌ها» is everything an ADMIN may do there,
 * write-off and wallet credit included. That is the owner's grant to make.
 */
export function customGroupRole(
  perms: SectionPerms,
  method: string,
  pattern: string,
): AccessRole | null {
  const entry = sectionEntry(pattern);
  if (!entry) return null;
  const [, editors, ...viewers] = entry;
  const m = method === 'HEAD' ? 'GET' : method;
  const key = `${m} ${pattern}`;
  const may = (s: Section, level?: 'edit') =>
    s !== '*' && (level ? perms[s] === level : perms[s] !== undefined);

  const edits =
    [editors].flat().some((s) => may(s, 'edit')) ||
    (ALSO_EDITED_BY.get(key) ?? []).some((s) => may(s, 'edit'));
  if (edits) return 'ADMIN';
  if (m !== 'GET' && !VIEW_POSTS.has(key)) return null;

  const readers = [...[editors].flat(), ...viewers];
  if (readers.some((s) => may(s))) return 'REVIEWER';
  return readers.includes('*') ? 'READ_ONLY' : null;
}
