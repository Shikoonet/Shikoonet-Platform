/**
 * Choosing an adapter, and naming the remote account.
 */

import { marzbanAdapter } from './marzban.js';
import { manualAdapter } from './manual.js';
import type { ProvisioningAdapter, RenewMode } from './types.js';

export * from './types.js';
export * from './schemaCheck.js';
export { marzbanAdapter } from './marzban.js';
export { manualAdapter } from './manual.js';

/**
 * The kinds we can actually deliver.
 *
 * `provisioning_providers.kind` allows nine values because the schema was
 * written for the product model, not for what is built. Seven of them —
 * marzban, marzneshin, hiddify, xui, wireguard, ai_account, spotify — have no
 * adapter and every one of them falls to `manual` below, which puts the order
 * in a human's queue instead of pretending.
 *
 * That is not a placeholder to be embarrassed about: all five panels in
 * production are `pasarguard`, so this covers every live provider today.
 *
 * `marzban` being on the unbuilt list is deliberate, not an oversight. Every
 * live panel is PasarGuard filed under Marzban's name (see the header of
 * `marzban.ts`), and PasarGuard's field names are not Marzban's. A classic
 * Marzban panel routed to this adapter would be sent `group_ids` and
 * `proxy_settings`, drop both without an error, and hand the customer an
 * account with no inbounds. Falling to manual is the loud failure.
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
 * Renewal is per panel, and the setting arrived with the migration.
 *
 * `provisioning_providers.config` keeps every legacy column the schema did not
 * claim a place for, so the two the admin set in the old bot are already there:
 *
 *     status_extend  'on_extend' | 'off_extend'   — may this panel be renewed
 *     Methodextend   a Persian phrase             — how
 *
 * Matching on a Persian phrase from a settings table is not something to build
 * on, so `renew_mode` is read first and is what an admin sets from here on. The
 * legacy key is only the fallback that makes the five live panels work on the
 * day this ships, and 'ADD' is spelled out rather than defaulted to: getting
 * this wrong the other way — RESET on a panel meant to accumulate — silently
 * deletes volume a customer already paid for.
 */
const LEGACY_ADD_METHOD = 'اضافه شدن زمان و حجم به ماه بعد';

export function renewModeFor(config: Record<string, unknown>): RenewMode {
  const explicit = config['renew_mode'];
  if (typeof explicit === 'string' && explicit.toUpperCase() === 'ADD') return 'ADD';
  if (typeof explicit === 'string' && explicit.toUpperCase() === 'RESET') return 'RESET';
  return config['Methodextend'] === LEGACY_ADD_METHOD ? 'ADD' : 'RESET';
}

/**
 * Whether this panel may be renewed at all.
 *
 * One production panel is `off_extend`, and honouring that is the difference
 * between "the admin turned this off" and "the admin's setting was ignored by
 * the new bot".
 */
export function renewAllowed(config: Record<string, unknown>): boolean {
  const explicit = config['renew_enabled'];
  if (typeof explicit === 'boolean') return explicit;
  return config['status_extend'] !== 'off_extend';
}

/**
 * What one extra gigabyte and one extra day cost on this panel, in IRR.
 *
 * The admin has been setting these for years, per panel and per customer tier,
 * and they are already in `config` — the migration carried the whole legacy row
 * across. Production, on the VIP panel: `{"f":"50000","n":"5000","n2":"5000"}`
 * for volume, `{"f":"15000","n":"4000","n2":"4000"}` for time.
 *
 *   f    ordinary customer
 *   n    reseller
 *   n2   reseller, second tier
 *
 * Stored in TOMAN, like every other price in the old database, so it is
 * multiplied here — this is the edge the toman rule talks about, and nothing
 * downstream sees anything but IRR.
 *
 * The units come from the PHP and not from a reading of the field names:
 * `index.php:2702` divides the paid amount by the rate to get days
 * (`priceـper_day`), and `index.php:2116` multiplies the rate by gigabytes.
 *
 * Null means "not for sale here" — an unreadable value, a missing tier, zero,
 * or a panel the admin set to `off_extend`. It is never a guess.
 */
export interface ExtraPricing {
  volumeIrrPerGb: number | null;
  timeIrrPerDay: number | null;
}

export type CustomerTier = 'f' | 'n' | 'n2';

export function extraPricingFor(
  config: Record<string, unknown>,
  tier: CustomerTier,
): ExtraPricing {
  if (!renewAllowed(config)) return { volumeIrrPerGb: null, timeIrrPerDay: null };
  return {
    volumeIrrPerGb: tomanRate(config['priceextravolume'], tier),
    timeIrrPerDay: tomanRate(config['priceextratime'], tier),
  };
}

/** `{"f":"50000",…}` → 500000 IRR, or null for anything that is not a price. */
function tomanRate(raw: unknown, tier: CustomerTier): number | null {
  // The column is text in the legacy database and jsonb here, so both shapes
  // arrive. A string that is not JSON is a setting nobody can act on, not a
  // reason to fail a customer's screen.
  let table: unknown = null;
  if (typeof raw === 'string') {
    try {
      table = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    table = raw;
  }
  if (table === null || typeof table !== 'object') return null;
  const value = (table as Record<string, unknown>)[tier];
  const toman = typeof value === 'number' ? value : Number(value);
  // A rate of zero would make an add-on free and an unbounded one — the
  // customer types the gigabytes, so zero times anything is a giveaway.
  if (!Number.isFinite(toman) || toman <= 0) return null;
  return Math.round(toman) * 10;
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
