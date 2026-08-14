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

export interface PlanPatch {
  name?: string;
  priceIrr?: number;
  durationDays?: number | null;
  volumeGb?: number | null;
  status?: 'ACTIVE' | 'HIDDEN' | 'DISABLED';
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

  setProductStatus(id: number, status: 'ACTIVE' | 'HIDDEN' | 'DISABLED') {
    return req<{ ok: boolean; status: string }>(`/products/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
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
