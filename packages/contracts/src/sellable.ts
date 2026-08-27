/**
 * «آیا این را می‌شود به کسی فروخت؟» — one answer, for every screen that claims
 * to know.
 *
 * WHY THIS EXISTS. On 2026-08-27 the dashboard said «۱۶ محصول، همه در فروشگاه»
 * and the bot sold three. Five of seven panels were switched off, so thirteen
 * products could not be delivered to anybody — and «محصولات», «دسته‌بندی‌ها» and
 * «سرویس‌ها» each drew a green badge over the top of that. The bot was the only
 * honest screen in the building, and the shop's owner was reading the other
 * three. Every one of his four complaints that day came out of this one gap.
 *
 * The data was never missing. `provider.status` already arrives on every row of
 * `GET /admin/products` and `GET /admin/catalog`; both screens simply drew the
 * PLAN's status instead and threw the panel's away.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT. `PURCHASABLE` in
 * `apps/bot/src/catalog.ts` has six conditions. Two of them — `resellers_only`
 * and `once_per_user` — depend on WHO is asking, and an admin screen has no
 * customer in hand. Those two are deliberately absent here: «فقط نماینده» is a
 * decision the operator made and the screens already show it, while everything
 * below is something BROKEN. Mixing the two would put a red badge on a working
 * reseller tier, which is how a warning stops being read.
 *
 * So this covers exactly the user-independent half:
 *
 *     pr.status = 'ACTIVE'   ·  the panel
 *     p.status  = 'ACTIVE'   ·  the service
 *     pl.status = 'ACTIVE'   ·  the config
 *     pr.capacity > live     ·  the panel's ceiling
 *
 * plus one case SQL cannot have — a product with no panel at all, which the
 * LEFT JOIN lets through and delivery then cannot fulfil.
 *
 * THIS MUST NOT BECOME A SECOND OPINION. It restates a predicate that lives in
 * SQL, and two definitions of the same thing drift. `sellable.test.ts` seeds one
 * row per `kind`, drives a real update through the bot's own `handleUpdate`, and
 * asserts the bot really hides it. That test is the reason this file is allowed
 * to exist; without it this is a comment that renders.
 */

/** Everything the answer depends on, in the shape both the browser and the routes hold it. */
export interface SellableFacts {
  /** `product_plans.status`. */
  planStatus: string;
  /** `products.status`. */
  productStatus: string;
  /** The panel, or null when the service names none. */
  panel: {
    name: string;
    /** `provisioning_providers.status`. */
    status: string;
    /** `provisioning_providers.capacity`; null is unlimited. */
    capacity?: number | null;
    /** Live subscriptions on this panel — ACTIVE and ON_HOLD, as the bot counts them. */
    liveSubscriptions?: number | null;
  } | null;
}

export type NotSellable =
  | { kind: 'NO_PANEL' }
  | { kind: 'PANEL_OFF'; panel: string }
  | { kind: 'PANEL_FULL'; panel: string; capacity: number; live: number }
  | { kind: 'PRODUCT_OFF'; status: string }
  | { kind: 'PLAN_OFF'; status: string };

/**
 * Every reason this row cannot reach a customer. Empty means it can.
 *
 * A list rather than the first reason found: a config that is hidden AND sits on
 * a switched-off panel needs both fixing, and telling an operator about one at a
 * time is how the second one gets discovered in production.
 *
 * The order is the order to fix them in — outermost first. Turning a config back
 * on while its panel is off changes nothing a customer can see.
 */
export function whyNotSellable(facts: SellableFacts): NotSellable[] {
  const out: NotSellable[] = [];
  const { panel } = facts;

  if (panel === null) {
    out.push({ kind: 'NO_PANEL' });
  } else if (panel.status !== 'ACTIVE') {
    out.push({ kind: 'PANEL_OFF', panel: panel.name });
  } else if (
    // NULL capacity is unlimited — the legacy 'unlimited' string became NULL in
    // the migration, so a missing number must never read as a ceiling of zero.
    panel.capacity != null &&
    panel.liveSubscriptions != null &&
    panel.capacity <= panel.liveSubscriptions
  ) {
    out.push({
      kind: 'PANEL_FULL',
      panel: panel.name,
      capacity: panel.capacity,
      live: panel.liveSubscriptions,
    });
  }

  if (facts.productStatus !== 'ACTIVE') {
    out.push({ kind: 'PRODUCT_OFF', status: facts.productStatus });
  }
  if (facts.planStatus !== 'ACTIVE') {
    out.push({ kind: 'PLAN_OFF', status: facts.planStatus });
  }

  return out;
}

/** Whether a customer could buy this, ignoring who the customer is. */
export function isSellable(facts: SellableFacts): boolean {
  return whyNotSellable(facts).length === 0;
}

const STATUS_FA: Record<string, string> = {
  HIDDEN: 'پنهان',
  DISABLED: 'غیرفعال',
};

/**
 * One reason, in the sentence an operator can act on.
 *
 * Named after the CONSEQUENCE, not the column: «پنل خاموش است» is a fact about
 * our database and «فروخته نمی‌شود» is a fact about the shop, and only the
 * second one tells somebody whether to care. That is the voice
 * `CatalogPage`'s «هر خریدی از این سرویس شکست می‌خورد» already speaks in, and
 * the voice `PanelsPage`'s «از خرید و تمدید برداشته شده» already speaks in.
 */
export function notSellableFa(reason: NotSellable): string {
  switch (reason.kind) {
    case 'NO_PANEL':
      return 'پنل ندارد، پس هیچ‌چیزی برای تحویل نیست.';
    case 'PANEL_OFF':
      return `پنل «${reason.panel}» خاموش است و از خرید و تمدید برداشته شده.`;
    case 'PANEL_FULL':
      return `پنل «${reason.panel}» به سقفش رسیده — ${faDigits(reason.live)} اشتراک زنده از ${faDigits(reason.capacity)}.`;
    case 'PRODUCT_OFF':
      return `سرویسش ${STATUS_FA[reason.status] ?? reason.status} است.`;
    case 'PLAN_OFF':
      return `خودش ${STATUS_FA[reason.status] ?? reason.status} است.`;
  }
}

/** The short form for a table cell, where the full sentence does not fit. */
export function notSellableShortFa(reason: NotSellable): string {
  switch (reason.kind) {
    case 'NO_PANEL':
      return 'بدون پنل';
    case 'PANEL_OFF':
      return 'پنل خاموش';
    case 'PANEL_FULL':
      return 'پنل پر است';
    case 'PRODUCT_OFF':
      return `سرویس ${STATUS_FA[reason.status] ?? reason.status}`;
    case 'PLAN_OFF':
      return STATUS_FA[reason.status] ?? reason.status;
  }
}

/**
 * Persian digits without pulling `Intl` into a module the bot also loads.
 *
 * `apps/admin-web/src/format.ts` and `apps/dashboard-worker/src/fa.ts` each have
 * a real formatter with grouping; this is only ever handed a subscription count
 * and a capacity, both small, and neither wants a thousands separator.
 */
function faDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
}
