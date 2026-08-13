/**
 * Choosing an adapter, and naming the remote account.
 */

import { marzbanAdapter } from './marzban.js';
import { manualAdapter } from './manual.js';
import type { ProvisioningAdapter } from './types.js';

export * from './types.js';
export { marzbanAdapter } from './marzban.js';
export { manualAdapter } from './manual.js';

/**
 * The kinds we can actually deliver.
 *
 * `provisioning_providers.kind` allows eight values because the schema was
 * written for the product model, not for what is built. Five of them —
 * marzneshin, hiddify, xui, wireguard, ai_account, spotify — have no adapter
 * yet and every one of them falls to `manual` below, which puts the order in a
 * human's queue instead of pretending.
 *
 * That is not a placeholder to be embarrassed about: all five panels in
 * production are `marzban`, so this covers every live provider today.
 */
const ADAPTERS = new Map<string, ProvisioningAdapter>([
  [marzbanAdapter.kind, marzbanAdapter],
  [manualAdapter.kind, manualAdapter],
]);

/**
 * The adapter for a provider kind, falling back to manual.
 *
 * Never throws and never returns null. An unknown kind is a product we can sell
 * but not yet deliver automatically, and the safe reading of that is "a person
 * finishes this" — not an exception in the middle of a sweep that has already
 * taken the customer's money.
 */
export function adapterFor(kind: string): ProvisioningAdapter {
  return ADAPTERS.get(kind) ?? manualAdapter;
}

/** True when `kind` has a real adapter rather than falling back to manual. */
export function isAutomated(kind: string): boolean {
  return ADAPTERS.has(kind) && kind !== manualAdapter.kind;
}

/**
 * The account name on the remote panel.
 *
 * Shaped like the ones already in production — `369469521_ce4c`,
 * `5633385607_ff620a55` — because support staff and the admin read these in the
 * panel every day and a new shape would be a new thing to learn. Three of the
 * five live panels are set to "numeric id + random letters and digits", which
 * is exactly this.
 *
 * The one change is that the suffix is not random. It is the order's public id,
 * which is already unique, so the same order always produces the same username.
 * That is what makes provisioning idempotent: a sweep that created the account
 * and then died before writing the row asks for the same name next time and
 * finds what it made, instead of creating a second account the customer never
 * hears about and nobody bills for.
 *
 * The WHOLE public id, not a prefix of it. Truncating to eight characters — the
 * length the production suffixes happen to have — made two of this user's
 * orders collide once every few billion pairs, and the failure mode is not a
 * clash: the adapter finds the existing account and reports success, so the
 * customer pays for a second service and receives their first one again.
 * Uniqueness is already guaranteed one column over; throwing it away to match a
 * cosmetic length was not a trade worth making.
 */
export function remoteUsernameFor(telegramId: number, orderPublicId: string): string {
  const suffix = orderPublicId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${telegramId}_${suffix}`;
}
