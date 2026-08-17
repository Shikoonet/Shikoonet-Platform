/**
 * The bot's admin panel is a subset of the web panel, and stays one.
 *
 * The plan for merging the two panels says the bot keeps its panel — an admin
 * with a phone and no laptop is the case it exists for — but that nothing may
 * live *only* there. Without something checking, that decays quietly: somebody
 * adds a thirteenth bot permission next quarter, it is genuinely useful, and six
 * months later there are two panels again with different powers.
 *
 * So every entry in `ADMIN_PERMISSIONS` names the web route that covers it, and
 * this file asserts that route is actually registered on the app. Two ways to go
 * red, both of them the ones that matter:
 *
 *   - a new bot permission with no line here — a type error, because the map is
 *     `Record<AdminPermission, …>` and TypeScript wants it exhaustive
 *   - a web route renamed or removed — a failure here, because the path is
 *     looked up in Hono's own route table rather than trusted
 *
 * Hono's `app.routes` is the outside truth on purpose. A list of strings
 * compared to another list of strings would prove the two lists agree and
 * nothing about whether the server answers.
 */

import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminPermission } from '@shikoo/contracts';
import { app } from '../src/index.js';

/**
 * What the web panel offers instead of each bot action.
 *
 * A permission maps to the route an operator would use for the same job. Where
 * the bot's action is a read of something the web draws from a wider endpoint,
 * that endpoint is named — «the same information», not «the same URL shape».
 */
const WEB_EQUIVALENT: Record<AdminPermission, { method: string; path: string }> = {
  // The payment hub's six screens, now the «پول» group.
  'claims.view': { method: 'GET', path: '/api/v1/payments' },
  'claims.approve': { method: 'POST', path: '/api/v1/match/approve' },
  'claims.reject': { method: 'POST', path: '/api/v1/match/reject' },
  // Not `/match/approve` — that one requires a transaction candidate and 404s
  // without one. The stronger permission is verifying a claim with no bank
  // transaction behind it at all, which is `verifyMirzabotClaimWithoutTransaction`.
  // Written down because the first version of this map guessed a plausible path
  // and would have been a green test asserting nothing.
  'claims.approve_without_tx': { method: 'POST', path: '/api/v1/suspects/:claimId/verify-manual' },
  // The dashboard's own figures: customers, sales, wallet float.
  'stats.view': { method: 'GET', path: '/api/v1/admin/overview' },
  'users.view': { method: 'GET', path: '/api/v1/admin/customers' },
  'users.wallet': { method: 'POST', path: '/api/v1/admin/customers/:id/wallet' },
  'users.block': { method: 'POST', path: '/api/v1/admin/customers/:id/status' },
  'users.discount': { method: 'POST', path: '/api/v1/admin/customers/:id/discount' },
  'users.message': { method: 'POST', path: '/api/v1/admin/customers/:id/message' },
  // The two that had no web equivalent until `bulkRoutes.ts`, and the reason
  // this file exists.
  'bulk.credit': { method: 'POST', path: '/api/v1/admin/bulk/credit' },
  'bulk.message': { method: 'POST', path: '/api/v1/admin/bulk/broadcast' },
};

/** Every path Hono will actually route, by method. */
const REGISTERED = new Set(app.routes.map((r) => `${r.method} ${r.path}`));

describe('the bot panel is a strict subset of the web panel', () => {
  it.each(ADMIN_PERMISSIONS)('«%s» has a web route', (permission) => {
    const { method, path } = WEB_EQUIVALENT[permission];
    expect(REGISTERED.has(`${method} ${path}`), `${method} ${path} is not registered`).toBe(true);
  });

  it('names an equivalent for every permission the bot has', () => {
    // The map is exhaustive by type; this is the same claim at runtime, so a
    // permission added through a cast rather than an edit still trips it.
    expect(Object.keys(WEB_EQUIVALENT).sort()).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it('reads real routes, so a typo in the map cannot pass', () => {
    // The guard proving itself: a path that is deliberately wrong must not be
    // found. Without this, an empty or mis-shaped `app.routes` would make every
    // assertion above vacuous.
    expect(REGISTERED.has('POST /api/v1/admin/bulk/credit-typo')).toBe(false);
    expect(REGISTERED.size).toBeGreaterThan(50);
  });
});
