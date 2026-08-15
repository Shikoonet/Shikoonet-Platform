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
  };
  provider: { id: number; name: string | null; code: string | null; status: string | null } | null;
  categoryName: string | null;
  ordersCount: number;
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
}

export interface CategoryRow {
  id: number;
  name: string;
  sortOrder: number;
  productsCount: number;
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
export interface PanelItem {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  baseUrl: string | null;
  capacity: number | null;
  sortOrder: number;
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
    return req<{ ok: boolean }>(`/bot-admins/${id}`, { method: 'POST', body: JSON.stringify(body) });
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
      items: PlanRow[];
      providers: ProviderOption[];
    }>(`/products?${qs.toString()}`);
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

  createCategory(name: string, sortOrder = 0) {
    return req<{ ok: boolean; category: CategoryRow }>('/product-categories', {
      method: 'POST',
      body: JSON.stringify({ name, sortOrder }),
    });
  },

  setProductStatus(id: number, status: CatalogStatus) {
    return req<{ ok: boolean; status: string }>(`/products/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  panels() {
    return req<{ ok: boolean; items: PanelItem[] }>('/panels');
  },

  updatePanel(
    id: number,
    patch: {
      name?: string;
      status?: 'ACTIVE' | 'DISABLED';
      capacity?: number | null;
      sortOrder?: number;
    },
  ) {
    return req<{ ok: boolean; panel: PanelItem; liveSubscriptions: number }>(`/panels/${id}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
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
    return req<{ ok: boolean; items: ResellerRequestRow[] }>(
      `/reseller-requests?${qs.toString()}`,
    );
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
    }>('/bot-texts');
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
      ordersToday: number;
      walletHeldIrr: number;
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
