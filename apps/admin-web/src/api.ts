/**
 * Every call this panel makes, in one place.
 *
 * All of it is under `/api/v1/admin/`, which is a separate Cloudflare Access
 * application from the payment hub — a token minted for that dashboard does
 * not verify here. Nothing in this file may reach outside that prefix; if a
 * screen needs something the payment hub already has, it gets its own admin
 * route rather than borrowing across the boundary.
 */

const BASE = '/api/v1/admin';

/**
 * One line the platform wrote about itself.
 *
 * `err` stays the raw string the process stored rather than a parsed object:
 * the copy button's whole promise is that what an admin sends is what was
 * written, and a shape this file invented on the way through would break that
 * the first time a driver error carried a field nobody predicted.
 */
export interface AppEventRow {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  svc: string;
  evt: string;
  trace: string | null;
  ref: string | null;
  fields: Record<string, unknown>;
  err: string | null;
}

export interface AppEventPage {
  ok: boolean;
  total: number;
  errors: number;
  warns: number;
  page: number;
  pageSize: number;
  items: AppEventRow[];
}

export interface EventFacets {
  ok: boolean;
  services: string[];
  events: Array<{ evt: string; svc: string; count: number }>;
}

/**
 * The level a reseller is on, or null. `percent` is the level's, and it is what
 * `effectiveDiscountPercent` will be showing whenever this is not null.
 */
export interface ResellerTierRef {
  code: 'n' | 'n2';
  name: string;
  percent: number;
}

export interface ResellerTierRow extends ResellerTierRef {
  /** Resellers on this level. A reseller with no level is counted as `n`. */
  members: number;
  updatedAt: string;
}

export interface CustomerListItem {
  id: number;
  telegramId: number;
  username: string | null;
  phone: string | null;
  status: string;
  isReseller: boolean;
  /** Their own standing percentage — stored, but not necessarily charged. */
  discountPercent: number;
  tier: ResellerTierRef | null;
  /**
   * What the bot will actually take off. The level's percentage when they are
   * on one, `discountPercent` otherwise — never compute this in the browser,
   * the two would drift the first time either rule changed.
   */
  effectiveDiscountPercent: number;
  balanceIrr: number;
  registeredAt: string;
  lastSeenAt: string | null;
}

export interface CustomerListPage {
  ok: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: CustomerListItem[];
}

export interface WalletEntryRow {
  amountIrr: number;
  kind: string;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

export interface CustomerDetail {
  id: number;
  telegramId: number;
  username: string | null;
  phone: string | null;
  phoneVerified: boolean;
  status: string;
  blockedReason: string | null;
  isReseller: boolean;
  /** Their own standing percentage — stored, but not necessarily charged. */
  discountPercent: number;
  tier: ResellerTierRef | null;
  /**
   * What the bot will actually take off. The level's percentage when they are
   * on one, `discountPercent` otherwise — never compute this in the browser,
   * the two would drift the first time either rule changed.
   */
  effectiveDiscountPercent: number;
  referralCode: string | null;
  balanceIrr: number;
  registeredAt: string;
  lastSeenAt: string | null;
  orderCount: number;
  paidTotalIrr: number;
}

/**
 * One sellable combination: a plan, with the product it belongs to.
 *
 * The panel this replaces has a single `product` row carrying all of it, so
 * this is the shape an admin already reads. Here the two are separate tables
 * and the join happens in SQL.
 */
export interface PlanRow {
  id: number;
  name: string;
  /** Drawn before the label on this config's bot button — «🆕», «🔴 آف». */
  badge: string | null;
  /** The colour of the button itself. Null = the client's own default. */
  buttonStyle: ButtonStyle | null;
  priceIrr: number;
  durationDays: number | null;
  volumeGb: number | null;
  userLimit: number | null;
  status: string;
  sortOrder: number;
  /** Where the admin broke the row on this category's screen; null = unarranged. */
  rowIndex: number | null;
  product: {
    id: number;
    code: string;
    name: string;
    kind: string;
    status: string;
    description: string | null;
    sortOrder: number;
    categoryId: number | null;
    resellersOnly: boolean;
    oncePerUser: boolean;
    /** null when this service does not decide and the panel's default applies. */
    groupIds: number[] | null;
  };
  provider: PanelRef | null;
  categoryName: string | null;
  ordersCount: number;
}

/**
 * One config — a price line inside a service.
 *
 * The same row `PlanRow` describes, minus the product it hangs off, because
 * here it hangs off the service that owns it instead of repeating it on every
 * line.
 */
export interface ConfigRow {
  id: number;
  name: string;
  badge: string | null;
  priceIrr: number;
  /** null is unmetered. Zero is a real, free allowance — not the same thing. */
  volumeGb: number | null;
  durationDays: number | null;
  userLimit: number | null;
  status: string;
  sortOrder: number;
  /** Which row of the bot's keyboard this sits on; null until somebody arranges it. */
  rowIndex: number | null;
  ordersCount: number;
}

/**
 * One service — what the customer picks first, with its configs inside it.
 *
 * `panel` is null for a service with no panel. That service cannot be sold at
 * all (the bot INNER JOINs the panel), which is exactly why it is listed rather
 * than hidden.
 */
export interface ServiceRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  description: string | null;
  sortOrder: number;
  categoryId: number | null;
  categoryName: string | null;
  resellersOnly: boolean;
  oncePerUser: boolean;
  /** null when this service does not choose, and the panel's default applies. */
  groupIds: number[] | null;
  /** Which row of its category's tier screen this service sits on. */
  rowIndex: number | null;
  panel: PanelRef | null;
  configs: ConfigRow[];
}

/**
 * The panel, as a catalogue row carries it.
 *
 * `capacity` and `liveSubscriptions` are here for `whyNotSellable`: a panel at
 * its ceiling takes its whole catalogue out of the shop, and without the two
 * numbers no screen can say so. Null capacity is unlimited.
 */
export interface PanelRef {
  id: number;
  name: string | null;
  code: string | null;
  status: string | null;
  /**
   * Whether «which groups?» is a question this route can answer at all.
   *
   * False for `manual` — the way a Spotify account or a gift card reaches a
   * customer. Decided on the server from the same table that picks the
   * adapter, so no screen has to keep its own list of which kinds have groups.
   */
  hasGroups: boolean;
  /**
   * Where the panel is, and whether it has a password — the two facts «مدیریت
   * پنل‌ها» has always shown and this row did not carry, so «سرویس‌ها» could
   * not tell «the panel cannot deliver» from «the groups are wrong» and always
   * said the second. Null address and no credential are normal for `manual`,
   * which is why `hasGroups` is asked first.
   */
  baseUrl: string | null;
  hasCredential: boolean;
  capacity: number | null;
  liveSubscriptions: number;
}

export interface ProviderOption {
  id: number;
  code: string;
  name: string;
  status: string;
}

export type CatalogStatus = 'ACTIVE' | 'HIDDEN' | 'DISABLED';

/**
 * The whole button's colour — Bot API 9.4's `style`, the same three names the
 * server, the CHECK in 0034 and the bot all spell. Null is «the client's own
 * default», which is what a button drew before this existed.
 */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface PlanPatch {
  name?: string;
  badge?: string | null;
  buttonStyle?: ButtonStyle | null;
  priceIrr?: number;
  durationDays?: number | null;
  volumeGb?: number | null;
  userLimit?: number | null;
  sortOrder?: number;
  status?: CatalogStatus;
}

/**
 * A new plan.
 *
 * `durationDays` and `volumeGb` are optional and mean NULL when absent —
 * unmetered, and no expiry. The server defaults them the same way rather than
 * substituting a number nobody chose.
 */
export interface PlanCreate {
  name: string;
  badge?: string | null;
  buttonStyle?: ButtonStyle | null;
  priceIrr: number;
  durationDays?: number | null;
  volumeGb?: number | null;
  userLimit?: number | null;
  sortOrder?: number;
  status?: CatalogStatus;
}

export interface ProductBody {
  code?: string;
  name?: string;
  kind?: string;
  providerId?: number | null;
  categoryId?: number | null;
  description?: string | null;
  resellersOnly?: boolean;
  oncePerUser?: boolean;
  sortOrder?: number;
  status?: CatalogStatus;
  /**
   * The panel groups an account bought here joins — this service's tier.
   *
   * `null` and `[]` are different and both are sent: null hands the decision
   * back to the panel's own default, `[]` means this service sends no groups at
   * all. Leaving the field out changes nothing.
   */
  groupIds?: number[] | null;
}

export interface CategoryRow {
  id: number;
  name: string;
  /** Drawn on the bot button before the name. Null when the admin gave it none. */
  badge: string | null;
  /** The colour of the button itself. Null = the client's own default. */
  buttonStyle: ButtonStyle | null;
  /** False takes this category's products off the shop without deleting anything. */
  active: boolean;
  sortOrder: number;
  /** Where the admin broke the row on the shop's first screen; null = never arranged. */
  rowIndex: number | null;
  /** SERVICES in this category — what a delete is refused over. */
  productsCount: number;
  /** CONFIGS in it — the unit «محصولات» lists and the bot draws a button per. */
  planCount: number;
  /**
   * How many of those configs a customer could actually buy — the number that
   * decides whether the bot draws a button for this category at all. A category
   * can hold seven and be invisible in the shop if every panel under it is off.
   */
  sellableCount: number;
}

export interface CategoryPatch {
  name?: string;
  badge?: string | null;
  buttonStyle?: ButtonStyle | null;
  sortOrder?: number;
  active?: boolean;
}

/**
 * One button in a saved arrangement.
 *
 * The ARRAY ORDER is the horizontal order and `sortOrder` is deliberately not
 * a field: the server writes it as the array index, so there is no second place
 * for the order to live and nothing for it to disagree with.
 */
export interface LayoutItem {
  id: number;
  rowIndex: number | null;
}

/** `categories` for the shop's first screen, `category:<id>` for one of them. */
/**
 * A screen the bot actually draws.
 *
 * `category:${number}` was here until 2026-08-27 and named a screen that had
 * stopped existing: a category lists its SERVICES, and the prices live one step
 * further in, on the service's own screen.
 */
/**
 * Which bot screen an arrangement is for.
 *
 * Three, and the first two are easy to confuse: `categories` is the screen
 * «خرید اشتراک» opens, `category:<id>` is the screen ONE category opens — its
 * tiers — and `service:<id>` is the screen one tier opens, its prices.
 */
export type LayoutScope = 'categories' | `category:${number}` | `service:${number}`;

/**
 * The seven windows the «آمار فروشگاه» screen offers.
 *
 * Deliberately not `HistoryRange` — that one belongs to the finance screens and
 * carries `2d`/`3d`/`7d`/`30d`, which this screen does not offer. The reasoning
 * for keeping them apart is in `packages/domain/src/statsRange.ts`.
 */
export type StatsRange =
  | 'all'
  | '1h'
  | 'today'
  | 'yesterday'
  | 'month'
  | 'prev_month'
  | 'day'
  | 'between';

export interface ShopStatsResponse {
  ok: boolean;
  range: StatsRange;
  /** The window measured. `null` on both means «everything». */
  startMs: number | null;
  endMs: number | null;

  /** Flows — these move with the range. */
  newCustomers: number;
  buyers: number;
  salesCount: number;
  salesIrr: number;
  renewalsCount: number;
  renewalsIrr: number;
  addonsCount: number;
  addonsIrr: number;
  /** Sales + renewals + add-ons. Not top-ups — that is money moved, not earned. */
  earnedIrr: number;
  topupsIrr: number;
  conversionPercent: number;
  avgPerBuyerIrr: number;
  renewalSharePercent: number;
  projectedMonthlyIrr: number;
  projectionDays: number;

  /** Stocks — always «now», whatever the range says. */
  customersTotal: number;
  activeSubscriptions: number;
  activeSubscriptionsIrr: number;
  walletHeldIrr: number;
  walletOwedToShopIrr: number;
  walletDebtors: number;
  resellers: number;
  panels: number;
  claimsWaiting: number;

  gateways: Array<{ method: string; count: number; irr: number }>;
  /** Figures the legacy screen has and this one will not invent. */
  notMeasured: Array<{ label: string; reason: string }>;
}

export interface StockRow {
  id: number;
  planId: number;
  planName: string;
  productName: string;
  providerName: string;
  remoteUsername: string;
  /** Null for a sold or retired row, and for anyone who is not an ADMIN: the
   *  link is the credential, and counting the shelf is not being handed it. */
  subscriptionUrl: string | null;
  status: 'AVAILABLE' | 'USED' | 'RETIRED';
  orderPublicId: string | null;
  note: string | null;
  createdAt: string;
  usedAt: string | null;
}

export interface ShelfCount {
  planId: number;
  planName: string;
  productName: string;
  available: number;
  used: number;
}

export interface StockPage {
  ok: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: StockRow[];
  shelves: ShelfCount[];
}

export interface StockBody {
  planId: number;
  remoteUsername: string;
  subscriptionUrl: string;
  note?: string | null;
}

/**
 * What a line of the shop's books IS.
 *
 * The sign alone said «which way» and never «what», and a screen built on it
 * reported 35.8 million Toman of fake receipts as money the shop had spent.
 */
export type LedgerKind = 'EXPENSE' | 'REVENUE_FIX' | 'MANUAL_INCOME';

export const LEDGER_KIND_FA: Record<LedgerKind, string> = {
  EXPENSE: 'هزینه',
  REVENUE_FIX: 'اصلاح درآمد',
  MANUAL_INCOME: 'درآمد دستی',
};

/**
 * What a bill arrived in. `IRR` means the row is what it has always been — a
 * Toman figure with no invoice behind it — and the other three carry the
 * original amount and the rate it was bought at.
 */
export type Currency = 'IRR' | 'EUR' | 'USD' | 'TON';

export const CURRENCY_FA: Record<Currency, string> = {
  IRR: 'تومان',
  EUR: 'یورو',
  USD: 'دلار',
  TON: 'تون',
};

/** Every currency but the one the books are kept in. */
export const FOREIGN_CURRENCIES: Currency[] = ['EUR', 'USD', 'TON'];

/**
 * One line of the shop's own books. `amountIrr` is SIGNED — negative is money
 * out — because that is how the row is stored and how the legacy log stored it
 * too. `kind` says what the row means; the sign only says which direction.
 */
export interface RevenueAdjustmentRow {
  id: number;
  amountIrr: number;
  note: string;
  kind: LedgerKind;
  categoryId: number | null;
  categoryName: string | null;
  /** The day the money moved, Gregorian on the wire. Not when it was typed. */
  spentOn: string;
  /**
   * The invoice behind the figure, when there was one. `originalAmount` and
   * `fxRateIrr` are both null exactly when `currency` is `IRR` — the schema
   * guarantees they travel together, so testing one is enough.
   *
   * `amountIrr` above is still the only figure anything adds up. These three
   * are the receipt: what the bill said, and what a unit cost on the day.
   */
  currency: Currency;
  originalAmount: number | null;
  /** Rial per unit. Divide by ten to show the Toman an admin typed. */
  fxRateIrr: number | null;
  /** The template this was posted from, if it was posted rather than typed. */
  recurrenceId: number | null;
  createdBy: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  /** From `audit_logs`, not a cached column — two records of one fact drift. */
  editCount: number;
  lastEditedAt: number | null;
  lastEditedBy: string | null;
}

export interface RevenueTotals {
  /** Negative or zero — what the shop actually spent. */
  expensesIrr: number;
  /** Corrections to income: a fake receipt, a duplicate charge. Either sign. */
  revenueFixIrr: number;
  /** Sales recorded by hand, mostly reseller top-ups. Positive. */
  manualIncomeIrr: number;
  /** The three above, added. */
  netIrr: number;
  /**
   * How many rows each figure was added up from.
   *
   * Sent because a total with no denominator cannot be checked: «−۷۵۴ میلیون»
   * is unverifiable, «−۷۵۴ میلیون از ۵۶ ردیف» can be clicked through to the
   * fifty-six.
   */
  expensesCount: number;
  revenueFixCount: number;
  manualIncomeCount: number;
  netCount: number;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
  /** So «غیرفعال کردن» can say what it costs before it is pressed. */
  rowCount: number;
}

/**
 * A cost that comes back — «هزینه یک ماهه سرور آلمان» and its next due date.
 *
 * `amountIrr` is a positive magnitude and a DEFAULT, not a total: nothing adds
 * this column up, and posting an instalment replaces it with what was actually
 * paid so a euro bill's Toman figure tracks the rate instead of going stale.
 *
 * There is no cron. `due` is answered by Postgres in Tehran and the screen shows
 * a button; a template nobody presses stays due and the number on the banner
 * grows, which is the right way for this to fail.
 */
export interface ExpenseRecurrence {
  id: number;
  label: string;
  categoryId: number | null;
  categoryName: string | null;
  amountIrr: number;
  period: 'MONTHLY' | 'YEARLY';
  /** Gregorian on the wire; the screen picks and shows it in Jalali. */
  nextDueOn: string;
  active: boolean;
  note: string;
  due: boolean;
}

export interface RevenueAdjustmentPage {
  ok: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: RevenueAdjustmentRow[];
  /** Over the current filter — the same rows the table is showing. */
  totals: RevenueTotals;
  /** Over the whole ledger, whatever the filter says. The shop's position. */
  lifetime: RevenueTotals;
  /**
   * The same figures over the window «آمار فروشگاه» is showing, or null when no
   * `range` was asked for or the range is unbounded («آمار کل»), in which case
   * `lifetime` is the answer.
   */
  rangeTotals: (RevenueTotals & { startMs: number; endMs: number }) | null;
  /** «تفکیک» — what the spending went on. Expenses only. */
  byCategory: Array<{
    categoryId: number | null;
    name: string | null;
    count: number;
    irr: number;
  }>;
}

/**
 * One view of the ledger, shared by the list and the export.
 *
 * A single type because the export's whole reason to exist is that it carries
 * the SAME rows the table is showing. Two shapes here would be two ways to say
 * «advertising in Mordad» and one of them would eventually mean something else.
 */
export interface LedgerFilter {
  kind?: LedgerKind | '';
  categoryId?: number | '';
  uncategorised?: boolean;
  /** Gregorian `YYYY-MM-DD`, on `spent_on`. The screen picks them in Jalali. */
  from?: string;
  to?: string;
  q?: string;
  voided?: 'hide' | 'show' | 'only';
  /**
   * Only «آمار فروشگاه» sends these, for the window it is showing.
   *
   * Named apart from `from`/`to` above, and sent as `rangeDay`/`rangeTo`,
   * because those two already mean this filter's own spend-date bounds. One
   * name for two windows is how a screen filters by one and totals by the
   * other.
   */
  range?: StatsRange;
  rangeDay?: string;
  rangeTo?: string;
}

export function ledgerQuery(f: LedgerFilter): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.kind) qs.set('kind', f.kind);
  if (f.uncategorised) qs.set('uncategorised', 'true');
  else if (f.categoryId) qs.set('categoryId', String(f.categoryId));
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  if (f.q) qs.set('q', f.q);
  if (f.voided && f.voided !== 'hide') qs.set('voided', f.voided);
  if (f.range) qs.set('range', f.range);
  if (f.rangeDay) qs.set('rangeDay', f.rangeDay);
  if (f.rangeTo) qs.set('rangeTo', f.rangeTo);
  return qs;
}

/**
 * How much, said one of the two ways the server accepts.
 *
 * Never both: a Toman figure sent beside a rate would be two answers to one
 * question and the server refuses it with a 400. The multiplication for a
 * foreign bill happens on the server, so the amount in the books is the one the
 * invoice and the rate produce — not a second rounding done in a browser.
 */
export type LedgerMoney =
  | { amountToman: number; currency?: 'IRR'; originalAmount?: never; fxRateToman?: never }
  | {
      amountToman?: never;
      currency: Exclude<Currency, 'IRR'>;
      /** What the invoice said: 35.5 for €35.50. */
      originalAmount: number;
      /** Toman for ONE unit, on the day the money left. */
      fxRateToman: number;
    };

/** One thing that was done to a ledger row, out of the append-only audit log. */
export interface LedgerHistoryEntry {
  action: string;
  actor: string;
  at: number;
  /** Only the fields that changed, with the same keys on both sides. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

/**
 * A channel the bot makes customers join. `chatRef` is what `getChatMember` is
 * given — an `@username` or a numeric `-100…` id, never a `t.me` URL — and
 * `joinLink` is what the button opens. The two are different things and the
 * form says so, because pasting the link into both is the mistake that leaves
 * the gate silently inert.
 */
export interface ChannelRow {
  id: number;
  title: string;
  chatRef: string;
  joinLink: string;
  active: boolean;
}

export interface HelpArticleRow {
  id: number;
  title: string;
  category: string | null;
  body: string;
  /** Whether an image came over with the row. The Telegram file id itself never
   *  leaves the server: it belongs to the old bot and sending it from this one
   *  fails at Telegram with nothing on screen to explain why. */
  hasMedia: boolean;
  sortOrder: number;
  active: boolean;
}

export interface HelpArticleBody {
  title: string;
  category?: string | null;
  body: string;
  sortOrder?: number;
  active?: boolean;
}

export interface ClientAppRow {
  id: number;
  name: string;
  platform: string | null;
  link: string;
  sortOrder: number;
  active: boolean;
}

export interface ClientAppBody {
  name: string;
  platform?: string | null;
  link: string;
  sortOrder?: number;
  active?: boolean;
}

export type PanelRole = 'ADMIN' | 'REVIEWER' | 'READ_ONLY';

export interface Me {
  email: string;
  role: PanelRole;
}

export interface AccessUserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: PanelRole;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export type BotAdminRoleName = 'OWNER' | 'ADMIN' | 'SUPPORT';

export interface BotAdminRow {
  id: number;
  telegramId: number;
  username: string | null;
  role: BotAdminRoleName;
  active: boolean;
  /** What was stored. The screen edits this. */
  permissions: Record<string, boolean>;
  /** What it comes to once the role's own meaning is applied. The screen shows this. */
  effective: string[];
  decisionsCount: number;
  ticketsCount: number;
}

export interface PermissionInfo {
  key: string;
  label: string;
}

/** What a refused delete counts, so the panel can say what is attached. */
export interface InUseCounts {
  orders: number;
  subscriptions: number;
  stock: number;
  discounts?: number;
}

/**
 * A fulfilment panel.
 *
 * There is no credential on this type and there is no route that returns one:
 * `secret_ref` names a secret in the runtime store and `config` carries a
 * shared secret provisioning has to send. `hasSecretRef` is the whole of what
 * this screen is allowed to know about it.
 */
export interface BulkPriceChange {
  providerId: number | null;
  mode: 'PERCENT' | 'FIXED';
  direction: 'UP' | 'DOWN';
  /** IRR when the mode is FIXED, whole percent when it is PERCENT. */
  amount: number;
  /**
   * Chosen when the preview is asked for and held until the change is applied
   * or the form is edited. A price change compounds, so a lost response must
   * not be able to make it twice.
   */
  operationId: string;
}

export interface BulkPricePreview {
  plans: number;
  currentTotalIrr: number;
  newTotalIrr: number;
  /** Plans the change would leave at zero or below, which refuses it whole. */
  unsellable: number;
  unchanged: number;
  examples: { name: string; fromIrr: number; toIrr: number }[];
}

/**
 * One send from «ارسال گروهی», as the audit log recorded it.
 *
 * `count` is how many rows the send actually wrote — 0 when a submission was
 * retried and the idempotency key caught it, which is worth showing rather than
 * hiding: it is the difference between "nobody was charged again" and "nothing
 * happened".
 */
export interface BulkSend {
  by: string;
  at: number;
  count: number;
  /** Rial per wallet. Null for a broadcast, which has no amount. */
  amountIrr: number | null;
}

/** What «تست ارتباط» answers. Never the panel's response body — see panelRoutes.ts. */
export interface PanelTestResult {
  ok: boolean;
  reachable: boolean;
  authenticated: boolean;
  /** True for a kind with nothing to log into, so the UI does not draw a green tick. */
  untestable?: boolean;
  ms?: number;
  /** How many groups the panel answered with. Proof the login worked. */
  groups?: number;
  /** Only from adapters with no group listing — see panelRoutes.ts. */
  accounts?: number;
  reason?: string;
}

/** One group as the panel reports it. */
export interface PanelGroupItem {
  id: number;
  name: string;
  memberCount?: number;
  inboundTags?: string[];
  /** How many of those inbounds have a host — the number the customer feels. */
  deliverableInbounds?: number;
  /** The panel's own on/off switch, when it has one. */
  disabled?: boolean;
}

/**
 * Every inbound the panel has, whether a group uses it or not.
 *
 * `inbounds: null` is «could not ask», never «has none» — the same distinction
 * `PanelGroups.available` makes, for the same reason.
 */
export interface PanelInbounds {
  ok: boolean;
  inbounds: Array<{ tag: string; hosted?: boolean }> | null;
  reason?: string;
}

/**
 * What a panel sends, what it has, and who ignores it.
 *
 * `available: null` means the panel could not be asked — NOT that it has no
 * groups. Rendering an empty list for an unreachable panel would invite an
 * operator to "fix" a selection that was correct.
 */
export interface PanelGroups {
  ok: boolean;
  /** The group ids this panel sends today. */
  selected: number[];
  available: PanelGroupItem[] | null;
  /** True for a kind that has no groups at all, so the UI says so rather than erroring. */
  untestable?: boolean;
  reason?: string;
  /**
   * Everything that overrides the panel's own tick — services and the plans
   * inside them. `level` says which, because «فروخته می‌شود در: پلاتینیوم» means
   * something different when پلاتینیوم is a whole service than when it is one
   * plan of one.
   */
  plans: Array<{ id: number; name: string; level: 'PRODUCT' | 'PLAN'; groups: unknown }>;
  /**
   * The services on this panel with no level of their own — the only ones the
   * panel's ticks still decide. Empty means the ticks decide nothing at all,
   * which a screen that draws them as the answer has to say out loud.
   */
  inherit: Array<{ id: number; name: string }>;
}

/**
 * How the part of the panel account name BEFORE the order id is built.
 *
 * Legacy offers eight; five of them are random or counted and cannot be
 * reproduced by a retry, so `remoteUsernameFor` carries only these three.
 */
export type PanelUsernameMode =
  | 'TELEGRAM_ID'
  | 'PANEL_TEXT'
  | 'TELEGRAM_USERNAME'
  | 'ORDER_ID'
  | 'CUSTOMER_TEXT'
  | 'PANEL_TEXT_SEQ';

/**
 * One price per customer tier, in TOMAN — `f` ordinary, `n` reseller, `n2`
 * reseller second tier.
 *
 * Null is «not sold at this tier», and it has to stay distinguishable from
 * zero: the shop already reads a zero price as not-for-sale, so a zero saved
 * here would look set on the screen and be off in the bot. The route refuses
 * zero for exactly that reason.
 */
export interface PanelTierPrices {
  f: number | null;
  n: number | null;
  n2: number | null;
}

/** A customer this panel is hidden from. Named by OUR user id, shown by theirs. */
export interface PanelHiddenUser {
  userId: number;
  telegramId: number;
  username: string | null;
  hiddenAt: string;
  hiddenBy: string | null;
}

export interface PanelItem {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  baseUrl: string | null;
  capacity: number | null;
  sortOrder: number;
  /**
   * Derived on the server from `config`, which itself never leaves — it carries
   * a hysteria shared secret. `'ADD'` accumulates volume and time onto a
   * renewal, `'RESET'` starts both over.
   */
  renewMode: 'ADD' | 'RESET' | 'ADD_VOLUME_RESET_TIME';
  /** «حداقل خرید» for add-ons. Null means no floor. */
  extraVolumeMinGb: number | null;
  extraTimeMinDays: number | null;
  /** A starter panel: only customers who own nothing can see it. */
  newcomersOnly: boolean;
  renewEnabled: boolean;
  /*
   * The rest of the panel's settings, derived on the server the same way and
   * for the same reason — each is produced by the function the bot reads with,
   * so the screen and the bot cannot come to disagree about them.
   */
  usernameMode: PanelUsernameMode;
  usernameText: string | null;
  /**
   * `enabled` is false unless BOTH numbers are usable — that is the server's
   * derivation, not a second rule here. A panel switched on with nothing to
   * give answers a customer's tap with a failed provision.
   */
  trial: { enabled: boolean; volumeGb: number | null; durationHours: number | null };
  extraVolumeTomanPerGb: PanelTierPrices;
  extraTimeTomanPerDay: PanelTierPrices;
  /** Where an ended account is moved. Empty means «leave it alone» — today's behaviour. */
  downgradeGroupIds: number[];
  hasSecretRef: boolean;
  productCount: number;
  planCount: number;
  liveSubscriptions: number;
}

/**
 * A discount or gift code.
 *
 * `state` is derived by the server from the same three conditions the bot
 * applies when a customer redeems — expiry, redemption count against
 * `maxUses`, and the kind. It is not a stored column, and this screen must not
 * recompute it: two derivations of one rule is how they drift apart.
 */
export interface DiscountItem {
  id: number;
  code: string;
  kind: string;
  amountIrr: number | null;
  percent: number | null;
  maxUses: number | null;
  used: number;
  appliesTo: string;
  firstPurchaseOnly: boolean;
  resellersOnly: boolean;
  product: { id: number; name: string | null } | null;
  provider: { id: number; name: string | null } | null;
  expiresAt: string | null;
  createdAt: string;
  state: 'USABLE' | 'EXPIRED' | 'USED_UP';
}

export interface RedemptionRow {
  id: number;
  amountIrr: number;
  createdAt: string;
  orderId: number | null;
  telegramId: number;
  username: string | null;
}

export interface CustomerRef {
  id: number;
  telegramId: number;
  username: string | null;
}

export interface OrderRow {
  id: number;
  publicId: string;
  kind: string;
  status: string;
  quantity: number;
  unitPriceIrr: number;
  discountIrr: number;
  totalIrr: number;
  failureReason: string | null;
  /**
   * The delivery lifecycle, separate from `status` on purpose: the payment is
   * already decided and a failed preparation must not be read as a failed
   * payment. Only FAILED_RETRYABLE offers a retry.
   */
  deliveryState: string;
  createdAt: string;
  completedAt: string | null;
  customer: CustomerRef;
  planName: string | null;
}

export interface SubscriptionRow {
  id: number;
  publicId: string;
  status: string;
  planName: string;
  providerName: string | null;
  priceIrr: number;
  volumeGb: number | null;
  durationDays: number | null;
  remoteUsername: string | null;
  purchasedAt: string;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  /** Bytes consumed, as the panel reported them at `lastSyncedAt`. */
  usedBytes: number | null;
  customer: CustomerRef;
}

export interface EntryRow {
  id: number;
  amountIrr: number;
  kind: string;
  actor: string | null;
  note: string | null;
  createdAt: string;
  orderId: number | null;
  paymentId: number | null;
  customer: CustomerRef;
}

/**
 * `value` is null for a secret key and always will be — the server does not
 * send it. `isSet` is the whole of what this screen may know about one.
 */
export interface SettingRow {
  scope: string;
  key: string;
  secret: boolean;
  value: unknown;
  isSet: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ResellerRequestRow {
  id: number;
  description: string | null;
  kind: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  customer: CustomerRef & { isReseller: boolean };
}

/**
 * A bot screen, as the registry names it.
 *
 * Sent by the server rather than listed here: the screens are defined next to
 * the texts in `@shikoo/contracts`, and a second list in this file would be the
 * one that goes stale the first time a screen is added.
 */
/**
 * Which bot the shop is. Never the token — the server does not send it, and
 * there is no field here that could hold it.
 */
export interface BotConnection {
  /** `dashboard` when a row set here is in force, `environment` when the service is still on its variable, `none` when nothing is. */
  source: 'dashboard' | 'environment' | 'none';
  envName: string;
  connected: {
    botId: number;
    username: string | null;
    firstName: string | null;
    envName: string;
    keyId: string;
    setBy: string | null;
    updatedAt: string;
  } | null;
  /** What the bot that is actually RUNNING said about itself at its last boot. */
  liveUsername: string | null;
  appliesAfter: string;
  /**
   * Where the shop's own reports go, and which topics exist.
   *
   * `chatId` null means nothing is configured and no report is sent at all. A
   * topic with `threadId` null is one that has not been made — its reports land
   * in the group's General rather than being lost, which is why the screen has
   * to say how many are set and not just whether a group is.
   */
  reportGroup: {
    chatId: number | null;
    configured: number;
    topics: { kind: string; title: string; threadId: number | null }[];
  };
}

export interface BotScreen {
  id: string;
  label: string;
}

/**
 * One editable sentence.
 *
 * `default` travels with it so the screen can show what it would say if reset,
 * and `customised` is whether a row exists — not whether the value differs,
 * which the client could compute and get subtly wrong.
 */
export interface BotTextRow {
  key: string;
  /** Which bot screen this line belongs to. Labels come from `BotScreen`. */
  screen: string;
  hint: string;
  placeholders: string[];
  default: string;
  value: string;
  customised: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface KeyboardButton {
  action: string;
  label: string;
  rowIndex: number;
  colIndex: number;
  visible: boolean;
  /** The whole button's colour. Null is the client's own default. */
  style: ButtonStyle | null;
}

export interface MenuActionInfo {
  action: string;
  label: string;
  hint: string;
  /** Cannot be removed or hidden — the screen is a dead end without it. */
  required?: boolean;
  /** The bot decides at draw time whether it applies at all. */
  conditional?: boolean;
  /** Slots the label must keep, e.g. `balance`. */
  placeholders?: string[];
}

/** One keyboard the bot draws, as the panel's selector lists it. */
export interface BotMenu {
  id: string;
  label: string;
  hint: string;
}

/**
 * The error carries the server's own code, not a rendered sentence.
 *
 * Screens branch on `code` (`admin_access_not_configured` is a different
 * situation from `forbidden`) and only fall back to `detail` for the field
 * message zod produced.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
  ) {
    super(detail ?? code);
  }
}

/**
 * `BASE` is prepended unless the caller already gave a whole path.
 *
 * Every route on this screen is an admin-surface one and passes «/orders»;
 * retrying a delivery is the exception, because it is a payments action a
 * REVIEWER must be able to take and therefore does not live under
 * `/api/v1/admin/`. One branch here beats a second copy of the transport.
 */
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${path.startsWith('/api/') ? '' : BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    credentials: 'include',
  });
  const body = (await r.json().catch(() => null)) as
    | (T & { error?: string; detail?: string })
    | null;
  if (!r.ok) {
    throw new ApiError(r.status, body?.error ?? String(r.status), body?.detail ?? null);
  }
  if (body === null) throw new ApiError(r.status, 'bad_response', null);
  return body;
}

export interface ImportDumpFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

export type ImportDomain =
  | 'core'
  | 'catalog'
  | 'sales'
  | 'discounts'
  | 'config'
  | 'history'
  | 'hub';

export type ImportMode = 'PREFLIGHT' | 'DRY_RUN' | 'APPLY';

export interface ImportReportLine {
  level: 'title' | 'step' | 'ok' | 'warn' | 'fail' | 'detail' | 'count';
  text: string;
}

export interface ImportRun {
  id: string;
  mode: ImportMode;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  dump_path: string;
  dump_bytes: number | null;
  domains: ImportDomain[];
  /** Present when this run left rows that can still be taken back. */
  undo_schema?: string | null;
  undone_at?: string | null;
  undone_by?: string | null;
  report?: ImportReportLine[];
  samples?: Record<string, Record<string, unknown>[]>;
  error: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
}

export const api = {
  me() {
    return req<{ ok: boolean } & Me>('/me');
  },

  accessUsers() {
    return req<{ ok: boolean; you: string; items: AccessUserRow[] }>('/access-users');
  },

  createAccessUser(body: { email: string; role: PanelRole; displayName?: string | null }) {
    return req<{ ok: boolean; id: string }>('/access-users', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateAccessUser(id: string, body: { role?: PanelRole; active?: boolean }) {
    return req<{ ok: boolean }>(`/access-users/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  deleteAccessUser(id: string) {
    return req<{ ok: boolean }>(`/access-users/${id}`, { method: 'DELETE' });
  },

  botAdmins() {
    return req<{ ok: boolean; permissions: PermissionInfo[]; items: BotAdminRow[] }>('/bot-admins');
  },

  createBotAdmin(body: {
    telegramId: number;
    username?: string | null;
    role: BotAdminRoleName;
    permissions?: Record<string, boolean>;
  }) {
    return req<{ ok: boolean; id: number }>('/bot-admins', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateBotAdmin(
    id: number,
    body: { role?: BotAdminRoleName; active?: boolean; permissions?: Record<string, boolean> },
  ) {
    return req<{ ok: boolean }>(`/bot-admins/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  deleteBotAdmin(id: number) {
    return req<{ ok: boolean }>(`/bot-admins/${id}`, { method: 'DELETE' });
  },

  customers(params: {
    q?: string;
    status?: string;
    page: number;
    pageSize: number;
    sort?: 'recent' | 'balance' | 'debt';
    reseller?: 'yes' | 'no';
  }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.sort && params.sort !== 'recent') qs.set('sort', params.sort);
    if (params.reseller) qs.set('reseller', params.reseller);
    return req<CustomerListPage>(`/customers?${qs.toString()}`);
  },

  customer(id: number) {
    return req<{ ok: boolean; customer: CustomerDetail; entries: WalletEntryRow[] }>(
      `/customers/${id}`,
    );
  },

  adjustWallet(id: number, body: { amountIrr: number; note: string; idempotencyKey: string }) {
    return req<{ ok: boolean; applied: boolean; balanceIrr: number; negative?: boolean }>(
      `/customers/${id}/wallet`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  setStatus(id: number, body: { status: 'ACTIVE' | 'BLOCKED'; reason: string | null }) {
    return req<{ ok: boolean; changed: boolean; status: string }>(`/customers/${id}/status`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  products(params: {
    q?: string;
    status?: string;
    providerId?: number;
    categoryId?: number;
    /** Undefined is «both». True and false are two different questions. */
    resellersOnly?: boolean;
    /** Same rule: undefined is «both», `false` asks for what cannot be sold. */
    sellable?: boolean;
    page: number;
    pageSize: number;
  }) {
    const qs = new URLSearchParams({
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.providerId) qs.set('providerId', String(params.providerId));
    if (params.categoryId) qs.set('categoryId', String(params.categoryId));
    if (params.categoryId) qs.set('categoryId', String(params.categoryId));
    if (params.resellersOnly !== undefined) qs.set('resellersOnly', String(params.resellersOnly));
    if (params.sellable !== undefined) qs.set('sellable', String(params.sellable));
    return req<{
      ok: boolean;
      total: number;
      /** How many of `total` a customer could actually buy — counted server-side
       *  over the whole filter, not over the page. */
      sellableTotal: number;
      page: number;
      pageSize: number;
      items: PlanRow[];
      providers: ProviderOption[];
    }>(`/products?${qs.toString()}`);
  },

  /** The same catalogue as `products()`, paged by service instead of by config. */
  catalog(params: {
    q?: string;
    status?: string;
    providerId?: number;
    categoryId?: number;
    page?: number;
    pageSize: number;
  }) {
    const qs = new URLSearchParams({
      // `?? 1` and not `String(params.page)`: `page` is optional on this
      // method, and `String(undefined)` is the STRING "undefined", which the
      // server coerces to NaN and answers `invalid_query`. The tier-layout
      // editor is the one caller that omits it, so the category screen showed
      // a bare error code where the arrangement should have been. `products()`
      // right above already carries this `?? 1` — it was patched at one call
      // site instead of at the shape that allowed it.
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.providerId) qs.set('providerId', String(params.providerId));
    // Declared in the type above since this method was written, and never put
    // on the wire. The route reads it, so the request was not rejected — it
    // answered with the WHOLE catalogue. «چیدمان سرویس‌های این دسته‌بندی» was
    // therefore arranging every service in the shop, and nothing said so. The
    // `invalid_query` beside it was the loud half of the same call; this was
    // the quiet half, and the quiet half is the one that would have shipped.
    if (params.categoryId) qs.set('categoryId', String(params.categoryId));
    return req<{
      ok: boolean;
      total: number;
      page: number;
      pageSize: number;
      items: ServiceRow[];
      panels: ProviderOption[];
    }>(`/catalog?${qs.toString()}`);
  },

  updatePlan(id: number, patch: PlanPatch) {
    return req<{ ok: boolean; plan: PlanRow }>(`/products/plans/${id}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  createPlan(productId: number, plan: PlanCreate) {
    return req<{ ok: boolean; plan: PlanRow }>(`/products/${productId}/plans`, {
      method: 'POST',
      body: JSON.stringify(plan),
    });
  },

  deletePlan(id: number) {
    return req<{ ok: boolean }>(`/products/plans/${id}`, { method: 'DELETE' });
  },

  createProduct(body: ProductBody) {
    return req<{ ok: boolean; productId: number }>('/products', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateProduct(id: number, body: ProductBody) {
    return req<{ ok: boolean }>(`/products/${id}`, { method: 'POST', body: JSON.stringify(body) });
  },

  deleteProduct(id: number) {
    return req<{ ok: boolean }>(`/products/${id}`, { method: 'DELETE' });
  },

  productCategories() {
    return req<{ ok: boolean; items: CategoryRow[] }>('/product-categories');
  },

  createCategory(body: {
    name: string;
    badge?: string | null;
    buttonStyle?: ButtonStyle | null;
    sortOrder?: number;
  }) {
    return req<{ ok: boolean; category: CategoryRow }>('/product-categories', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateCategory(id: number, patch: CategoryPatch) {
    return req<{ ok: boolean }>(`/product-categories/${id}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  deleteCategory(id: number) {
    return req<{ ok: boolean }>(`/product-categories/${id}`, { method: 'DELETE' });
  },

  /**
   * Save one shop screen's arrangement.
   *
   * `items` must be the WHOLE screen, in the order it should be drawn — the
   * server refuses a partial save rather than applying it, because the rows it
   * was not told about would keep their old positions and interleave with the
   * new ones.
   */
  saveCatalogLayout(scope: LayoutScope, items: LayoutItem[]) {
    return req<{ ok: boolean }>(`/catalog-layout/${scope}`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },

  setProductStatus(id: number, status: CatalogStatus) {
    return req<{ ok: boolean; status: string }>(`/products/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  stock(params: { planId?: number; status?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.planId !== undefined) qs.set('planId', String(params.planId));
    if (params.status) qs.set('status', params.status);
    return req<StockPage>(`/stock?${qs.toString()}`);
  },

  addStock(body: StockBody) {
    return req<{ ok: boolean; id: number }>('/stock', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  retireStock(id: number) {
    return req<{ ok: boolean }>(`/stock/${id}/retire`, { method: 'POST', body: '{}' });
  },

  deleteStock(id: number) {
    return req<{ ok: boolean }>(`/stock/${id}`, { method: 'DELETE' });
  },

  revenueAdjustments(params: LedgerFilter & { page: number; pageSize: number }) {
    const qs = ledgerQuery(params);
    qs.set('page', String(params.page));
    qs.set('pageSize', String(params.pageSize));
    return req<RevenueAdjustmentPage>(`/revenue-adjustments?${qs.toString()}`);
  },

  /**
   * The URL of the export, for an `<a href>` rather than a fetch.
   *
   * A download has to be a navigation: fetching it into memory and building a
   * blob would put the whole filtered ledger through JavaScript to produce the
   * bytes the server already produced.
   */
  revenueAdjustmentsCsvUrl(params: LedgerFilter) {
    return `${BASE}/revenue-adjustments/export.csv?${ledgerQuery(params).toString()}`;
  },

  /**
   * A positive amount and a kind — never a signed amount.
   *
   * `kind` has no default on the server on purpose: a body that does not say
   * what a line is gets a 400 rather than a guess, because the guess would be
   * invisible and this is money.
   */
  addRevenueAdjustment(body: LedgerMoney & {
    kind: LedgerKind;
    direction?: 'expense' | 'credit';
    categoryId?: number | null;
    spentOn?: string;
    note: string;
  }) {
    return req<{ ok: boolean; id: number; amountIrr: number }>('/revenue-adjustments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  editRevenueAdjustment(
    id: number,
    body: Partial<LedgerMoney> & {
      kind?: LedgerKind;
      direction?: 'expense' | 'credit';
      categoryId?: number | null;
      spentOn?: string;
      note?: string;
      reason?: string;
    },
  ) {
    return req<{ ok: boolean; changed: boolean }>(`/revenue-adjustments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  /**
   * Voiding, which replaced deleting.
   *
   * The row stays and leaves every total. A reason is required — it is the
   * whole difference between a line that is gone and a line that is explained.
   */
  voidRevenueAdjustment(id: number, reason: string) {
    return req<{ ok: boolean }>(`/revenue-adjustments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  revenueAdjustmentHistory(id: number) {
    return req<{ ok: boolean; items: LedgerHistoryEntry[] }>(
      `/revenue-adjustments/${id}/history`,
    );
  },

  expenseCategories() {
    return req<{ ok: boolean; items: ExpenseCategory[] }>('/revenue-adjustments/categories');
  },

  addExpenseCategory(body: { name: string; sortOrder?: number }) {
    return req<{ ok: boolean; id: number }>('/revenue-adjustments/categories', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  editExpenseCategory(id: number, body: { name?: string; active?: boolean; sortOrder?: number }) {
    return req<{ ok: boolean }>(`/revenue-adjustments/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  expenseRecurrences() {
    return req<{ ok: boolean; items: ExpenseRecurrence[] }>('/revenue-adjustments/recurrences');
  },

  addExpenseRecurrence(body: {
    label: string;
    categoryId?: number | null;
    amountToman: number;
    period?: 'MONTHLY' | 'YEARLY';
    nextDueOn: string;
    note?: string;
  }) {
    return req<{ ok: boolean; id: number }>('/revenue-adjustments/recurrences', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  editExpenseRecurrence(
    id: number,
    body: {
      label?: string;
      categoryId?: number | null;
      amountToman?: number;
      period?: 'MONTHLY' | 'YEARLY';
      nextDueOn?: string;
      note?: string;
      active?: boolean;
    },
  ) {
    return req<{ ok: boolean }>(`/revenue-adjustments/recurrences/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  /**
   * Post one instalment: the ledger row and the advance, in one transaction on
   * the server. Everything is optional — the template answers it all, and this
   * body is only for the month that was different.
   */
  postExpenseRecurrence(
    id: number,
    body: Partial<LedgerMoney> & { spentOn?: string; note?: string } = {},
  ) {
    return req<{ ok: boolean; id: number; nextDueOn: string }>(
      `/revenue-adjustments/recurrences/${id}/post`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  setDiscount(id: number, body: { percent: number }) {
    return req<{
      ok: boolean;
      percent: number;
      /** What the customer will be charged — the level's, if they are on one. */
      effectivePercent: number;
      tierName: string | null;
    }>(`/customers/${id}/discount`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Makes somebody a reseller, or stops them being one. The level rides along. */
  setReseller(id: number, body: { isReseller: boolean; tier: 'n' | 'n2' | null }) {
    return req<{ ok: boolean; changed: boolean }>(`/customers/${id}/reseller`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  resellerTiers() {
    return req<{ ok: boolean; items: ResellerTierRow[] }>('/reseller-tiers');
  },

  /**
   * One number here moves the price for every reseller on that level.
   *
   * The percentage only. A level's NAME is seeded by 0047 and not editable —
   * the panel screen's own tier labels hardcode the same words, and one level
   * with two names is worse than one that cannot be renamed.
   */
  saveResellerTier(code: string, body: { percent: number }) {
    return req<{ ok: boolean; changed: boolean }>(`/reseller-tiers/${code}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Queued for the bot to send, not sent from the browser. */
  messageCustomer(id: number, body: { body: string; messageId: string }) {
    return req<{ ok: boolean; queued: number }>(`/customers/${id}/message`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** How many customers a bulk action would reach, before committing to it. */
  bulkReach() {
    return req<{ ok: boolean; reach: number }>('/bulk/reach');
  },

  /** The last credit and the last broadcast, so neither is sent twice by hand. */
  bulkRecent() {
    return req<{ ok: boolean; credit: BulkSend | null; broadcast: BulkSend | null }>(
      '/bulk/recent',
    );
  },

  /**
   * The batch id is the caller's, not the server's.
   *
   * A double-submit or a lost response has to land on the *same* batch or every
   * wallet is credited twice — the per-customer idempotency key is built from
   * it. The page generates one when the form opens and sends that same id with
   * the confirmation, which is what the bot does with its session.
   */
  bulkCredit(body: { amountIrr: number; batchId: string; note?: string }) {
    return req<{ ok: boolean; credited: number; reach: number }>('/bulk/credit', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  broadcast(body: { body: string; broadcastId: string }) {
    return req<{ ok: boolean; queued: number; reach: number }>('/bulk/broadcast', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /**
   * What a bulk price change would do. Writes nothing, so any operator may ask.
   *
   * There is no client-minted id here and there does not need to be: unlike a
   * credit, repricing twice by the same amount is visibly wrong on the price
   * list rather than silently doubled in eleven thousand wallets, and the
   * confirmation shows the resulting prices.
   */
  bulkPricePreview(body: BulkPriceChange) {
    return req<{ ok: boolean; preview: BulkPricePreview }>('/bulk/price/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  bulkPrice(body: BulkPriceChange) {
    return req<{ ok: boolean; changed: number; preview: BulkPricePreview }>('/bulk/price', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  requiredChannels() {
    return req<{ ok: boolean; items: ChannelRow[] }>('/required-channels');
  },

  addRequiredChannel(body: { title: string; chatRef: string; joinLink: string }) {
    return req<{ ok: boolean; id: number }>('/required-channels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  setRequiredChannelActive(id: number, active: boolean) {
    return req<{ ok: boolean }>(`/required-channels/${id}/active`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    });
  },

  deleteRequiredChannel(id: number) {
    return req<{ ok: boolean }>(`/required-channels/${id}`, { method: 'DELETE' });
  },

  botConnection() {
    return req<{ ok: boolean } & BotConnection>('/bot');
  },

  /**
   * Points the bot at a forum group and creates the report topics in it.
   *
   * The group must already have the bot in it as an admin — the server asks
   * Telegram and refuses with a sentence rather than letting ten topic
   * creations fail one by one.
   */
  setReportGroup(chatId: number) {
    return req<{
      ok: boolean;
      chatId: number;
      created: Record<string, number>;
    }>('/bot/report-group', { method: 'POST', body: JSON.stringify({ chatId }) });
  },

  setBotToken(token: string) {
    return req<{
      ok: boolean;
      connected: { botId: number; username: string | null; firstName: string | null };
    }>('/bot/token', { method: 'POST', body: JSON.stringify({ token }) });
  },

  helpArticles() {
    return req<{ ok: boolean; items: HelpArticleRow[] }>('/help-articles');
  },

  saveHelpArticle(id: number | null, body: HelpArticleBody) {
    return req<{ ok: boolean; article: HelpArticleRow }>(
      id === null ? '/help-articles' : `/help-articles/${id}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  deleteHelpArticle(id: number) {
    return req<{ ok: boolean }>(`/help-articles/${id}`, { method: 'DELETE' });
  },

  clientApps() {
    return req<{ ok: boolean; items: ClientAppRow[] }>('/client-apps');
  },

  saveClientApp(id: number | null, body: ClientAppBody) {
    return req<{ ok: boolean; app: ClientAppRow }>(
      id === null ? '/client-apps' : `/client-apps/${id}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  deleteClientApp(id: number) {
    return req<{ ok: boolean }>(`/client-apps/${id}`, { method: 'DELETE' });
  },

  events(params: {
    q?: string;
    level?: string;
    svc?: string;
    trace?: string;
    window?: string;
    page: number;
    pageSize: number;
  }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    for (const key of ['q', 'level', 'svc', 'trace', 'window'] as const) {
      const value = params[key];
      if (value) qs.set(key, value);
    }
    return req<AppEventPage>(`/events?${qs.toString()}`);
  },

  eventFacets(window: string) {
    return req<EventFacets>(`/events/facets?window=${encodeURIComponent(window)}`);
  },

  panels() {
    return req<{ ok: boolean; items: PanelItem[] }>('/panels');
  },

  createPanel(body: {
    code: string;
    name: string;
    kind: string;
    baseUrl?: string | null;
    capacity?: number | null;
    sortOrder?: number;
    credential?: { username: string; password: string };
  }) {
    // `probe` is present whenever the server actually tried the panel on the
    // way in — which is what decided whether the new row came out ACTIVE. It is
    // the difference between «غیرفعال شد» and a screen that can say why.
    return req<{ ok: boolean; panel: PanelItem; probe?: PanelTestResult }>('/panels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /**
   * Replace the panel's login. The username is optional and normally absent:
   * nothing here can read a stored one back, so the edit form's box is empty on
   * a panel that already has a credential, and the server fills it in from what
   * is already sealed. Omitting it on a panel with NO credential is a 400.
   */
  setPanelCredential(id: number, credential: { username?: string; password: string }) {
    return req<{ ok: boolean; panel: PanelItem | null }>(`/panels/${id}/credentials`, {
      method: 'POST',
      body: JSON.stringify(credential),
    });
  },

  /**
   * تست ارتباط. `id: 0` means "not saved yet" — the create form asking whether
   * the address and password it is holding actually work, before it writes
   * anything. A panel saved and then found broken is the order this avoids.
   */
  testPanel(
    id: number,
    body: {
      baseUrl?: string;
      kind?: string;
      credential?: { username: string; password: string };
    },
  ) {
    return req<PanelTestResult>(`/panels/${id}/test`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  panelGroups(id: number) {
    return req<PanelGroups>(`/panels/${id}/groups`);
  },

  /**
   * Which of the panel's own groups it sells by default.
   *
   * This was removed on 2026-08-24 with a note saying nothing read the column —
   * "`groupIdsFor` looks at the plan's attrs and the provider config, never at
   * that column". That column IS the provider config, and `provisioning.test.ts`
   * has a green case named «the panel default» proving delivery reads it. What
   * was actually broken was the value: every stored selection was `[]`, and `[]`
   * is not nullish, so it beat the panel underneath and the create body carried
   * `group_ids: []` — an account in no group, with no inbounds, on a link that
   * resolves and returns nothing.
   *
   * So an empty array here is honest: the route deletes the key rather than
   * storing it, and the panel goes back to naming no default.
   */
  setPanelGroups(id: number, groupIds: number[]) {
    return req<{ ok: boolean; panel: PanelItem | null }>(`/panels/${id}/groups`, {
      method: 'POST',
      body: JSON.stringify({ groupIds }),
    });
  },

  /**
   * The username a panel signs in with. Never the password — nothing can read
   * one back, which is why the box on the screen means «خالی = بدون تغییر».
   */
  panelCredentialUsername(id: number) {
    return req<{ ok: boolean; username: string | null; setBy: string | null; setAt: string | null }>(
      `/panels/${id}/credential-username`,
    );
  },

  panelInbounds(id: number) {
    return req<PanelInbounds>(`/panels/${id}/inbounds`);
  },

  /**
   * The three that write a group ON THE PANEL, at `panel-groups` rather than
   * `groups`.
   *
   * The two paths are one character apart and mean opposite things — `groups`
   * replaces this panel's whole SELECTION, `panel-groups` creates or edits one
   * group on the panel itself. Named apart on purpose: a typo between them
   * would silently rewrite what every existing customer of this panel is sold.
   */
  createPanelGroup(id: number, spec: { name: string; inboundTags: string[] }) {
    return req<{ ok: boolean; group: PanelGroupItem }>(`/panels/${id}/panel-groups`, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  },

  updatePanelGroup(id: number, groupId: number, spec: { name: string; inboundTags: string[] }) {
    return req<{ ok: boolean; group: PanelGroupItem }>(`/panels/${id}/panel-groups/${groupId}`, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  },

  deletePanelGroup(id: number, groupId: number) {
    return req<{ ok: boolean }>(`/panels/${id}/panel-groups/${groupId}`, { method: 'DELETE' });
  },

  /**
   * Empty a group into another one, so retiring a tier does not silently empty
   * its members' subscriptions.
   *
   * `moved` comes back on the ERROR path too — this is one request per member
   * against somebody else's panel, so «it failed» and «it failed after five»
   * are different things and the screen has to be able to say which.
   */
  movePanelGroupMembers(id: number, groupId: number, toGroupId: number) {
    return req<{ ok: boolean; moved: number; scanned: number }>(
      `/panels/${id}/panel-groups/${groupId}/move-members`,
      { method: 'POST', body: JSON.stringify({ toGroupId }) },
    );
  },




  updatePanel(
    id: number,
    patch: {
      name?: string;
      status?: 'ACTIVE' | 'DISABLED';
      capacity?: number | null;
      sortOrder?: number;
      baseUrl?: string | null;
      renewMode?: 'ADD' | 'RESET' | 'ADD_VOLUME_RESET_TIME';
      extraVolumeMinGb?: number | null;
      extraTimeMinDays?: number | null;
      newcomersOnly?: boolean;
      renewEnabled?: boolean;
      /**
       * Re-probe and let the answer set the status. Ignored when `status` is in
       * the same patch — a person's explicit choice outranks a probe, which is
       * what keeps a panel from getting stuck off after a bad ten minutes.
       */
      autoStatus?: boolean;
      usernameMode?: PanelUsernameMode;
      /** Trimmed, at most 32 characters. Null clears it back to the numeric id. */
      usernameText?: string | null;
      /**
       * The three trial fields move together, and the route checks the RESULT
       * of the merge rather than the patch — sending only the switch relies on
       * numbers already stored, and sending only a number relies on a switch
       * already on. Turning it on without both numbers is refused with a
       * Persian `detail`.
       */
      trialEnabled?: boolean;
      trialVolumeGb?: number | null;
      trialDurationHours?: number | null;
      /** All three tier keys required together; each a positive Toman integer or null. */
      extraVolumeTomanPerGb?: PanelTierPrices;
      extraTimeTomanPerDay?: PanelTierPrices;
      downgradeGroupIds?: number[] | null;
    },
  ) {
    return req<{
      ok: boolean;
      panel: PanelItem;
      liveSubscriptions: number;
      probe?: PanelTestResult;
    }>(`/panels/${id}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  /**
   * The customers this panel is hidden from.
   *
   * A deny list and short by nature — all five production panels have it empty
   * — so there is no paging and no search here.
   */
  panelHiddenUsers(id: number) {
    return req<{ ok: boolean; users: PanelHiddenUser[] }>(`/panels/${id}/hidden-users`);
  },

  /**
   * Hide it from one customer, named by their Telegram id.
   *
   * An id nobody has comes back 404 `user_not_found` rather than being stored:
   * the row is a foreign key onto `users`, so it can only name somebody who has
   * started the bot. Legacy stores the bare number, where a typo and a working
   * block look identical.
   */
  addPanelHiddenUser(id: number, telegramId: number) {
    return req<{ ok: boolean; userId: number; telegramId: number }>(`/panels/${id}/hidden-users`, {
      method: 'POST',
      body: JSON.stringify({ telegramId }),
    });
  },

  /** Let them see it again — by OUR user id, which the list above hands out. */
  removePanelHiddenUser(id: number, userId: number) {
    return req<{ ok: boolean }>(`/panels/${id}/hidden-users/${userId}`, { method: 'DELETE' });
  },

  /**
   * Remove the panel row. Nothing on the panel itself is touched.
   *
   * Refuses with 409 and `counts` while any service, live subscription or stock
   * config points at it — `subscriptions.provider_id` is `ON DELETE SET NULL`,
   * so without that guard Postgres would accept the delete and silently orphan
   * every subscription instead of raising.
   */
  deletePanel(id: number) {
    return req<{ ok: boolean }>(`/panels/${id}`, { method: 'DELETE' });
  },

  discounts(params: { q?: string; state?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.state) qs.set('state', params.state);
    return req<{
      ok: boolean;
      total: number;
      page: number;
      pageSize: number;
      filteredByState: string | null;
      items: DiscountItem[];
    }>(`/discounts?${qs.toString()}`);
  },

  createDiscount(body: Record<string, unknown>) {
    return req<{ ok: boolean; discount: DiscountItem }>('/discounts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  expireDiscount(id: number) {
    return req<{ ok: boolean; changed: boolean; discount: DiscountItem }>(
      `/discounts/${id}/expire`,
      { method: 'POST' },
    );
  },

  redemptions(id: number) {
    return req<{ ok: boolean; items: RedemptionRow[] }>(`/discounts/${id}/redemptions`);
  },

  orders(p: { q?: string; status?: string; kind?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({ page: String(p.page), pageSize: String(p.pageSize) });
    if (p.q) qs.set('q', p.q);
    if (p.status) qs.set('status', p.status);
    if (p.kind) qs.set('kind', p.kind);
    return req<{ ok: boolean; total: number; items: OrderRow[] }>(`/orders?${qs.toString()}`);
  },

  /**
   * Ask for the preparation to be tried again. Never re-approves the payment.
   *
   * `confirmed` is a literal, not a variable, for the same reason the payments
   * hub sends it that way: the server requires it, so a screen that forgot to
   * ask the operator also fails to send it.
   */
  retryProvisioning(publicId: string) {
    return req<{ ok: boolean; outcome: string; orderPublicId: string }>(
      `/api/v1/orders/${encodeURIComponent(publicId)}/retry-provisioning`,
      { method: 'POST', body: JSON.stringify({ confirmed: true }) },
    );
  },

  subscriptions(p: { q?: string; status?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({ page: String(p.page), pageSize: String(p.pageSize) });
    if (p.q) qs.set('q', p.q);
    if (p.status) qs.set('status', p.status);
    return req<{ ok: boolean; total: number; items: SubscriptionRow[] }>(
      `/subscriptions?${qs.toString()}`,
    );
  },

  walletEntries(p: { q?: string; kind?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({ page: String(p.page), pageSize: String(p.pageSize) });
    if (p.q) qs.set('q', p.q);
    if (p.kind) qs.set('kind', p.kind);
    return req<{
      ok: boolean;
      total: number;
      creditIrr: number;
      debitIrr: number;
      items: EntryRow[];
    }>(`/wallet-entries?${qs.toString()}`);
  },

  settings(p: { scope?: string; q?: string } = {}) {
    const qs = new URLSearchParams();
    if (p.scope) qs.set('scope', p.scope);
    if (p.q) qs.set('q', p.q);
    return req<{ ok: boolean; items: SettingRow[]; hiddenCount: number }>(
      `/settings?${qs.toString()}`,
    );
  },

  updateSetting(body: { scope: string; key: string; value: string }) {
    return req<{ ok: boolean; setting: SettingRow }>('/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  resellerRequests(status?: string) {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    return req<{ ok: boolean; items: ResellerRequestRow[] }>(`/reseller-requests?${qs.toString()}`);
  },

  /** `tier` is only read on APPROVED; null there means level one. */
  decideResellerRequest(
    id: number,
    status: 'APPROVED' | 'REJECTED',
    tier: 'n' | 'n2' | null = null,
  ) {
    return req<{ ok: boolean; status: string }>(`/reseller-requests/${id}`, {
      method: 'POST',
      body: JSON.stringify({ status, tier }),
    });
  },

  botTexts() {
    return req<{
      ok: boolean;
      screens: BotScreen[];
      items: BotTextRow[];
      maxLength: number;
      customEmoji: boolean;
    }>('/bot-texts');
  },

  setCustomEmoji(enabled: boolean) {
    return req<{ ok: boolean; enabled: boolean }>('/bot-custom-emoji', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  saveBotText(key: string, value: string) {
    return req<{ ok: boolean; customised: boolean }>('/bot-texts', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  },

  botKeyboard(menu: string) {
    return req<{
      ok: boolean;
      menu: string;
      menus: BotMenu[];
      customised: boolean;
      buttons: KeyboardButton[];
      actions: MenuActionInfo[];
      maxLabelLength: number;
    }>(`/bot-keyboard/${menu}`);
  },

  saveBotKeyboard(menu: string, buttons: KeyboardButton[]) {
    return req<{ ok: boolean }>(`/bot-keyboard/${menu}`, {
      method: 'POST',
      body: JSON.stringify({ buttons }),
    });
  },

  resetBotKeyboard(menu: string) {
    return req<{ ok: boolean }>(`/bot-keyboard/${menu}/reset`, { method: 'POST' });
  },

  overview() {
    return req<{
      ok: boolean;
      customers: number;
      customersToday: number;
      activeSubscriptions: number;
      revenueIrr: number;
      /** Signed, and NOT included in `revenueIrr` — the dashboard adds them. */
      revenueAdjustmentIrr: number;
      ordersToday: number;
      walletHeldIrr: number;
      walletOwedToShopIrr: number;
      walletDebtors: number;
      recentCustomers: CustomerListItem[];
      recentOrders: Array<{
        publicId: string;
        telegramId: number | null;
        planName: string | null;
        totalIrr: number;
        status: string;
        createdAt: string;
      }>;
    }>('/overview');
  },

  /**
   * The «آمار فروشگاه» screen.
   *
   * `day` is only read when `range` is `'day'`; sending it otherwise is
   * harmless and the server ignores it, so the page does not have to remember
   * to clear the date picker when the operator moves back to a period button.
   */
  stats(range: StatsRange, day?: string, to?: string) {
    const q = new URLSearchParams({ range });
    if ((range === 'day' || range === 'between') && day) q.set('day', day);
    if (range === 'between' && to) q.set('to', to);
    return req<ShopStatsResponse>(`/stats?${q.toString()}`);
  },

  importFiles() {
    return req<{ ok: boolean; dir: string; items: ImportDumpFile[] }>('/import/files');
  },

  importRuns() {
    return req<{ ok: boolean; items: ImportRun[] }>('/import/runs');
  },

  importRun(id: string) {
    return req<{ ok: boolean; run: ImportRun }>(`/import/runs/${encodeURIComponent(id)}`);
  },

  /**
   * Puts a dump on the server, reporting how much of it has gone.
   *
   * `XMLHttpRequest`, and it is the only one in this file. `fetch` cannot
   * report upload progress — `ReadableStream` request bodies would, but they
   * need HTTP/2 and `duplex: 'half'`, and they are unshipped in Safari. XHR has
   * had `upload.onprogress` since before any of this existed. A progress bar
   * that lies about a 6 MB file is worse than none, and this is the native way
   * to make it honest.
   *
   * The body is the `File` itself, not a `FormData`. There is one field.
   *
   * Errors are mapped to `ApiError` by hand so the page can keep using
   * `message()`. A 413 is the one that matters: nginx answers it with HTML, so
   * there is no `error` field to read and the code is supplied here.
   */
  uploadDump(file: File, onProgress: (fraction: number) => void): Promise<{ name: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/import/upload?name=${encodeURIComponent(file.name)}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        const body = (() => {
          try {
            return JSON.parse(xhr.responseText) as { name?: string; error?: string; detail?: string };
          } catch {
            return null;
          }
        })();
        if (xhr.status >= 200 && xhr.status < 300 && body?.name !== undefined) {
          resolve({ name: body.name });
          return;
        }
        reject(
          new ApiError(
            xhr.status,
            body?.error ?? (xhr.status === 413 ? 'body_too_large' : String(xhr.status)),
            body?.detail ?? null,
          ),
        );
      };
      // Both fire with status 0 and no body: a dropped connection and a
      // cancelled request are the same event to this caller.
      xhr.onerror = () => reject(new ApiError(0, 'network', null));
      xhr.onabort = () => reject(new ApiError(0, 'aborted', null));
      xhr.send(file);
    });
  },

  /**
   * Takes back exactly the rows one APPLY inserted.
   *
   * Not a restore, and the page says so where it is pressed: anything
   * created after the import stays.
   */
  undoImport(id: string) {
    return req<{ ok: boolean; total: number; removed: { table: string; rows: number }[] }>(
      `/import/runs/${encodeURIComponent(id)}/undo`,
      { method: 'POST' },
    );
  },

  /** `mode` picks the endpoint; the body is the same for all three. */
  startImport(mode: ImportMode, body: { file: string; domains: ImportDomain[] }) {
    const path = mode === 'PREFLIGHT' ? 'preflight' : mode === 'DRY_RUN' ? 'dry-run' : 'apply';
    return req<{ ok: boolean; id: string }>(`/import/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

};
