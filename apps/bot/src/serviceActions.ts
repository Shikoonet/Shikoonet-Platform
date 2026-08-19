/**
 * Which buttons a service gets, and which way the on/off one points.
 *
 * Lived in `handle.ts` until 2026-08-19, private to the callback handler,
 * because the service screen was somewhere a customer navigated to. It is now
 * also the screen they are handed the moment a purchase completes — which is
 * produced by `provision.ts`, a file `handle.ts` must not import from and vice
 * versa. So it moved here, where both can reach it and neither owns it.
 *
 * The move made one thing explicit that had been hidden: the shop settings are
 * an argument now, not a module-level `let` read from whichever file happened
 * to have refreshed it last.
 */

import { extraPricingFor, isAutomated } from '@shikoo/domain';
import type { ShopSettings } from './settings.js';
import type * as menu from './menu.js';
import type { OwnedSubscriptionOnPanel } from './owned.js';

/**
 * Null for a manual product, for a row whose panel was deleted, and for one the
 * panel never named — there is nothing to call in any of those, and a button
 * that cannot work is worse than no button.
 */
export function actionsFor(
  service: OwnedSubscriptionOnPanel,
  shop: ShopSettings,
  tier: menu.CustomerTier = 'f',
): menu.ServiceActions | null {
  if (!service.provider_kind || !service.provider_base_url || !service.remote_username) return null;
  if (!isAutomated(service.provider_kind)) return null;
  // REMOVED, FAILED, PENDING_PAYMENT: nothing to revoke and nothing to switch.
  if (service.status !== 'ACTIVE' && service.status !== 'DISABLED') return null;
  const pricing = extraPricingFor(service.provider_config ?? {}, tier);
  return {
    id: service.id,
    disabled: service.status === 'DISABLED',
    // A panel that prices an add-on can still be a shop that does not sell it.
    // Production has had both of these switched off for years while our bot
    // drew the buttons anyway.
    volumeIrrPerGb: shop.sellsExtraVolume ? pricing.volumeIrrPerGb : null,
    timeIrrPerDay: shop.sellsExtraTime ? pricing.timeIrrPerDay : null,
    canSwitch: shop.allowsServiceSwitch,
  };
}

/**
 * Which price column this customer is charged from.
 *
 * The legacy `agent` field is three tiers and we carry one flag, so a reseller
 * reads the reseller column and everybody else the ordinary one. `n2` exists in
 * the data and is priced identically to `n` on every live panel, so nothing is
 * lost by not having a third flag yet.
 */
export function tierFor(user: { is_reseller: boolean }): menu.CustomerTier {
  return user.is_reseller ? 'n' : 'f';
}
