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

export interface CustomerListItem {
  id: number;
  telegramId: number;
  username: string | null;
  phone: string | null;
  status: string;
  isReseller: boolean;
  discountPercent: number;
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
  discountPercent: number;
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
  priceIrr: number;
  /** null is unmetered. Zero is a real, free allowance — not the same thing. */
  volumeGb: number | null;
  durationDays: number | null;
  userLimit: number | null;
  status: string;
  sortOrder: number;
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

export interface PlanPatch {
  name?: string;
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
  emoji: string | null;
  /** False takes this category's products off the shop without deleting anything. */
  active: boolean;
  sortOrder: number;
  /** Where the admin broke the row on the shop's first screen; null = never arranged. */
  rowIndex: number | null;
  productsCount: number;
  /**
   * How many of those a customer could actually buy — the number that decides
   * whether the bot draws a button for this category at all. A category can hold
   * seven products and be invisible in the shop if every panel under it is off.
   */
  sellableCount: number;
}

export interface CategoryPatch {
  name?: string;
  emoji?: string | null;
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
export type LayoutScope = 'categories' | `category:${number}`;

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
 * One line of the shop's own books. `amountIrr` is SIGNED — negative is a cost —
 * because that is how the row is stored and how the legacy log stored it too.
 * There is no `type` field to disagree with the sign.
 */
export interface RevenueAdjustmentRow {
  id: number;
  amountIrr: number;
  note: string;
  createdBy: string | null;
  createdAt: string;
}

/** Over the whole ledger, never over the page. */
export interface RevenueTotals {
  /** Negative or zero. */
  expensesIrr: number;
  creditsIrr: number;
  netIrr: number;
}

export interface RevenueAdjustmentPage {
  ok: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: RevenueAdjustmentRow[];
  totals: RevenueTotals;
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
 * One host — the thing a subscription is actually built out of.
 *
 * The panel has no inbound endpoint (`POST /api/inbound` is 404), because an
 * inbound is part of its Xray core config. A host is what points at an inbound
 * and carries the address, and an inbound with no host delivers nothing. So
 * this is what «اینباند تازه» on the screen creates, and the screen says so.
 */
export interface PanelHostItem {
  id: number;
  remark: string;
  inboundTag: string;
  addresses: string[];
  disabled: boolean;
}

export interface PanelHosts {
  ok: boolean;
  hosts: PanelHostItem[] | null;
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
  renewMode: 'ADD' | 'RESET';
  renewEnabled: boolean;
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

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
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

  customers(params: { q?: string; status?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
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
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.providerId) qs.set('providerId', String(params.providerId));
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
    page: number;
    pageSize: number;
  }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.providerId) qs.set('providerId', String(params.providerId));
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

  createCategory(body: { name: string; emoji?: string | null; sortOrder?: number }) {
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

  revenueAdjustments(params: { direction?: string; page: number; pageSize: number }) {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.direction) qs.set('direction', params.direction);
    return req<RevenueAdjustmentPage>(`/revenue-adjustments?${qs.toString()}`);
  },

  /** A positive amount and a direction — never a signed amount. */
  addRevenueAdjustment(body: {
    amountToman: number;
    direction: 'expense' | 'credit';
    note: string;
  }) {
    return req<{ ok: boolean; id: number; amountIrr: number }>('/revenue-adjustments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  deleteRevenueAdjustment(id: number) {
    return req<{ ok: boolean }>(`/revenue-adjustments/${id}`, { method: 'DELETE' });
  },

  setDiscount(id: number, body: { percent: number }) {
    return req<{ ok: boolean; percent: number }>(`/customers/${id}/discount`, {
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

  panelHosts(id: number) {
    return req<PanelHosts>(`/panels/${id}/hosts`);
  },

  createPanelHost(id: number, spec: { remark: string; inboundTag: string; addresses: string[] }) {
    return req<{ ok: boolean; host: PanelHostItem }>(`/panels/${id}/hosts`, {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  },

  deletePanelHost(id: number, hostId: number) {
    return req<{ ok: boolean }>(`/panels/${id}/hosts/${hostId}`, { method: 'DELETE' });
  },

  updatePanel(
    id: number,
    patch: {
      name?: string;
      status?: 'ACTIVE' | 'DISABLED';
      capacity?: number | null;
      sortOrder?: number;
      baseUrl?: string | null;
      renewMode?: 'ADD' | 'RESET';
      renewEnabled?: boolean;
      /**
       * Re-probe and let the answer set the status. Ignored when `status` is in
       * the same patch — a person's explicit choice outranks a probe, which is
       * what keeps a panel from getting stuck off after a bad ten minutes.
       */
      autoStatus?: boolean;
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

  decideResellerRequest(id: number, status: 'APPROVED' | 'REJECTED') {
    return req<{ ok: boolean; status: string }>(`/reseller-requests/${id}`, {
      method: 'POST',
      body: JSON.stringify({ status }),
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
};
