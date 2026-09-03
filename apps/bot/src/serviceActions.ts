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
    showsConfig: shop.showsConfigButton,
  };
}

/**
 * Which price column this customer is charged from.
 *
 * The legacy `agent` field is three tiers, and until 0047 we carried one flag —
 * so this answered `n` or `f` and **`n2` was unreachable**. Every panel screen
 * has had a «نماینده سطح ۲» price box since the pricing fold was built, and no
 * customer could ever be charged from it.
 *
 * Counted rather than assumed, 2026-08-19, in the 2026-08-11 production dump:
 * 11,265 customers were `f` and exactly one was `n`. None was `n2` — which was
 * the *consequence* of this function, not evidence that the tier was unwanted.
 * Sam asked for both levels to be real on 2026-09-03, so the level now comes
 * from `users.reseller_tier` and that box finally decides a price.
 *
 * ## `is_reseller` still decides, and the tier only refines
 *
 * A reseller whose `reseller_tier` is NULL is level one. That is one rule and
 * it is deliberate: the flag is written in several places — the request-approval
 * route, the importer, the seed — and if any of them sets it without a level,
 * the alternative is a reseller silently paying the ORDINARY rate. Reading the
 * flag first makes that impossible, and it is why this change moves nobody's
 * price on the day it lands.
 *
 * The identical rule is spelled in SQL in `DISCOUNT_PERCENT` (`handle.ts`),
 * for the same reason `IS_ADMIN` beside it is spelled once: the two must agree,
 * so each of them says so and points at the other.
 *
 * An unknown string reads as level one rather than throwing. The column is a
 * foreign key onto `reseller_tiers`, whose CHECK allows only these two, so a
 * third value cannot be written today; if a later migration adds one and
 * forgets this function, the level the shop already had is the safe way to be
 * wrong.
 */
export function tierFor(user: {
  is_reseller: boolean;
  reseller_tier: string | null;
}): menu.CustomerTier {
  if (!user.is_reseller) return 'f';
  return user.reseller_tier === 'n2' ? 'n2' : 'n';
}
