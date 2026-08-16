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

import type { AccessRole } from '@shikoo/contracts';
import type { D1Database } from '@shikoo/database';

/**
 * What a READ_ONLY operator may not read on the admin surface.
 *
 * Every write route on this surface is behind `role !== 'ADMIN'`, and every
 * *read* route was behind nothing at all: a READ_ONLY row could open a named
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
  '/api/v1/admin/orders',
  '/api/v1/admin/subscriptions',
  '/api/v1/admin/wallet-entries',
  '/api/v1/admin/reseller-requests',
  // Who may operate the shop is not an operations detail.
  '/api/v1/admin/access-users',
  '/api/v1/admin/bot-admins',
  // Nor is what the shop spends. Not personal data — the other reason a path is
  // on this list — but the same answer: `nav.ts` does not draw «هزینه‌ها و
  // تعدیل‌ها» for a READ_ONLY operator, and a section hidden in the sidebar
  // while the API still answers is decoration rather than a boundary.
  '/api/v1/admin/revenue-adjustments',
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

export async function lookupRole(db: D1Database, email: string): Promise<AccessRole | null> {
  const row = await db
    .prepare(`SELECT role, active FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ role: AccessRole; active: number }>();
  if (!row || row.active !== 1) return null;
  return row.role;
}
