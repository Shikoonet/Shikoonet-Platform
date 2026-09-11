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
  /**
   * Required, with no default, and that is the point.
   *
   * It defaulted to `'f'` — an ordinary customer — so a caller that forgot it
   * compiled and quietly priced a reseller's add-ons from the wrong column.
   * `extraPricingFor` reads the rate PER TIER and a panel may legally price
   * `n` without pricing `f`, in which case the buttons the reseller was just
   * offered vanish on the next redraw: press QR, or switch the service off, or
   * have an action fail, and «➕ حجم اضافه» is gone. Four of the eight call
   * sites had drifted this way. A required parameter is what makes the
   * compiler name them.
   */
  tier: menu.CustomerTier,
): menu.ServiceActions | null {
  if (!service.provider_kind || !service.provider_base_url || !service.remote_username) return null;
  if (!isAutomated(service.provider_kind)) return null;
  /*
   * A credential, asked for beside the address it goes with.
   *
   * The address was already required here and the credential was not, which is
   * half a question: `login()` refuses a panel with no secret and answers
   * `retryable: false`, so an add-on bought on such a panel is taken, fails,
   * and — for a card-to-card payment — is not refunded automatically.
   *
   * This is the sibling of the shop-side hole in #182 and it is the one the
   * shop-side clause does NOT cover: «➕ حجم اضافه» and «➕ زمان اضافه» sell
   * against a service that already exists, so they never go near
   * `purchasablePlan`. Both spellings of «has a credential» count, the same two
   * `trialPanelsForUser` counts, because a panel wired before `provider_secrets`
   * existed resolves through the environment.
   *
   * Drawing no button is the right answer rather than failing at checkout: the
   * customer never spends anything, and an operator who fixes the panel gets
   * the buttons back on the next screen with nothing to unwind.
   *
   * ## What it asks, exactly
   *
   * Whether a credential is NAMED, not whether it RESOLVES. A `secret_ref`
   * pointing at a `PANEL_<REF>` that is absent from the environment still draws
   * the buttons, and that panel still cannot log in. Deliberate, for two
   * reasons: it is the predicate `trialPanelsForUser` already uses for the same
   * question, so the tree agrees with itself; and a panel whose env var has
   * gone missing cannot provision anything either, so the add-on path is not
   * the exposure — a new purchase on it fails too, and that one IS refunded.
   * What this closes is the never-wired panel, which `migrate.ts` produces by
   * design and the dashboard counts as `panels_without_secret`.
   *
   * ## It takes away only what needs the panel
   *
   * An earlier version of this returned null for the WHOLE object, which also
   * withdrew «کانفیگ» — and that button never touches a panel. It encodes
   * `subscriptions.subscription_url`, a column the shelf and the last sync
   * already filled, so it works perfectly well on a panel nobody can log into.
   *
   * The state is not hypothetical: `migrate.ts` lands every imported provider
   * with an address and no `secret_ref` on purpose, the dashboard counts
   * `panels_without_secret` as a live condition, and a shelf-backed panel
   * legitimately has no credential at all because a shelf delivery hands out a
   * pre-made link without ever logging in. Taking the customer's own config
   * away from them in all three cases is a worse bug than the one being fixed.
   */
  // REMOVED, FAILED, PENDING_PAYMENT: nothing to revoke and nothing to switch.
  if (service.status !== 'ACTIVE' && service.status !== 'DISABLED') return null;
  const pricing = extraPricingFor(service.provider_config ?? {}, tier);
  const canReachPanel = Boolean(service.provider_secret_ref || service.provider_sealed);
  return {
    id: service.id,
    disabled: service.status === 'DISABLED',
    // A panel that prices an add-on can still be a shop that does not sell it.
    // Production has had both of these switched off for years while our bot
    // drew the buttons anyway.
    volumeIrrPerGb: canReachPanel && shop.sellsExtraVolume ? pricing.volumeIrrPerGb : null,
    timeIrrPerDay: canReachPanel && shop.sellsExtraTime ? pricing.timeIrrPerDay : null,
    canSwitch: canReachPanel && shop.allowsServiceSwitch,
    canRevoke: canReachPanel,
    // Deliberately NOT gated on the credential — see above.
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
