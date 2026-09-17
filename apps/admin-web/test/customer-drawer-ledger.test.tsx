/**
 * The wallet ledger inside a customer's card, in Persian.
 *
 * `entryNoteFa` and `actorFa` were written for «تراکنش‌ها» and wired only
 * there, so the same three sentences stayed English on the one screen an
 * operator opens while a customer is waiting on the other end of a chat:
 * «legacy balance carried over unchanged» and an actor column reading
 * `SYSTEM`. Two readers of one column, and only one of them was fixed —
 * which is the shape of bug that comes back, so it is asserted here rather
 * than only there.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CustomersPage } from '../src/pages/CustomersPage.js';
import type { CustomerDetail, CustomerListItem, OrderRow, SubscriptionRow } from '../src/api.js';

const LIST: CustomerListItem[] = [
  {
    id: 7,
    telegramId: 7_137_494_513,
    username: 'reza_kh',
    phone: null,
    status: 'ACTIVE',
    blockedReason: null,
    isReseller: false,
    discountPercent: 0,
    tier: null,
    effectiveDiscountPercent: 0,
    balanceIrr: 0,
    registeredAt: '2026-08-01T09:00:00Z',
    lastSeenAt: null,
  },
];

const DETAIL: CustomerDetail = {
  id: 7,
  telegramId: 7_137_494_513,
  username: 'reza_kh',
  phone: null,
  phoneVerified: false,
  status: 'ACTIVE',
  blockedReason: null,
  isReseller: false,
  discountPercent: 0,
  tier: null,
  effectiveDiscountPercent: 0,
  referralCode: null,
  balanceIrr: 0,
  registeredAt: '2026-08-01T09:00:00Z',
  lastSeenAt: null,
  orderCount: 0,
  paidTotalIrr: 0,
};

// The three shapes the importer and the bot actually write.
const ENTRIES = [
  {
    createdAt: '2026-08-01T09:00:00Z',
    kind: 'OPENING',
    amountIrr: 500_000,
    actor: 'SYSTEM',
    note: 'legacy balance carried over unchanged',
  },
  {
    createdAt: '2026-08-02T09:00:00Z',
    kind: 'RENEWAL_CASHBACK',
    amountIrr: 50_000,
    actor: 'SYSTEM',
    note: '5% of a renewal',
  },
  {
    createdAt: '2026-08-03T09:00:00Z',
    kind: 'ADMIN_ADJUST',
    amountIrr: -10_000,
    actor: 'sam@samsos.org',
    note: 'اصلاح دستی',
  },
];

// A top-up is an order with no plan. The «چه چیزی» cell read only the plan
// name and printed «—» for it until 2026-09-17.
const ORDERS: OrderRow[] = [
  {
    id: 91,
    publicId: 'SH-91',
    kind: 'WALLET_TOPUP',
    status: 'COMPLETED',
    quantity: 1,
    unitPriceIrr: 20_000_000,
    discountIrr: 0,
    totalIrr: 20_000_000,
    failureReason: null,
    deliveryState: 'DELIVERED',
    createdAt: '2026-09-17T06:22:00Z',
    completedAt: '2026-09-17T06:22:00Z',
    customer: { id: 7, telegramId: 7_137_494_513, username: 'reza_kh' },
    planName: null,
    remoteUsername: null,
    cardMasked: null,
  },
  {
    id: 92,
    publicId: 'SH-92',
    kind: 'NEW_PURCHASE',
    status: 'COMPLETED',
    quantity: 1,
    unitPriceIrr: 3_990_000,
    discountIrr: 0,
    totalIrr: 3_990_000,
    failureReason: null,
    deliveryState: 'DELIVERED',
    createdAt: '2026-09-17T06:30:00Z',
    completedAt: '2026-09-17T06:30:00Z',
    customer: { id: 7, telegramId: 7_137_494_513, username: 'reza_kh' },
    planName: '1ماهه-100گیگ',
    remoteUsername: 'reza_7613',
    cardMasked: '**** **** **** 7613',
  },
];

// One account on a panel that still exists, one whose panel is gone: the
// first is a link, the second is only a name.
const SUBS: SubscriptionRow[] = [
  {
    id: 51,
    publicId: 'SUB-51',
    status: 'ACTIVE',
    panelUserUrl: 'https://pg.example:8000/dashboard/#/users?search=reza_7613',
    planName: '1ماهه-100گیگ',
    providerName: 'سرویس تیتانیوم',
    priceIrr: 3_990_000,
    volumeGb: 100,
    durationDays: 30,
    remoteUsername: 'reza_7613',
    purchasedAt: '2026-09-17T06:30:00Z',
    expiresAt: '2026-10-17T06:30:00Z',
    lastSyncedAt: null,
    usedBytes: null,
    customer: { id: 7, telegramId: 7_137_494_513, username: 'reza_kh' },
  },
  {
    id: 52,
    publicId: 'SUB-52',
    status: 'DISABLED',
    panelUserUrl: null,
    planName: 'پلن قدیمی',
    providerName: 'پنل قدیمی',
    priceIrr: 1_000,
    volumeGb: null,
    durationDays: null,
    remoteUsername: 'old_acct',
    purchasedAt: '2026-01-01T06:30:00Z',
    expiresAt: null,
    lastSyncedAt: null,
    usedBytes: null,
    customer: { id: 7, telegramId: 7_137_494_513, username: 'reza_kh' },
  },
];

// Mutable so one test can open the drawer on a customer who has money.
let detail: CustomerDetail = DETAIL;
const adjustWallet = vi.fn(async (_id: number, body: { amountIrr: number }) => ({
  ok: true,
  applied: true,
  balanceIrr: detail.balanceIrr + body.amountIrr,
  negative: false,
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      customers: async () => ({ ok: true, total: 1, page: 1, pageSize: 25, items: LIST }),
      customer: async () => ({ ok: true, customer: detail, entries: ENTRIES }),
      adjustWallet: (id: number, body: { amountIrr: number }) => adjustWallet(id, body),
      orders: async () => ({ ok: true, total: ORDERS.length, page: 1, pageSize: 10, items: ORDERS }),
      subscriptions: async () => ({ ok: true, total: SUBS.length, page: 1, pageSize: 10, items: SUBS }),
      customerHistory: async () => ({ ok: true, items: [] }),
    },
  };
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  detail = DETAIL;
  vi.restoreAllMocks();
});

describe('the wallet ledger in a customer’s card', () => {
  it('says in Persian what the note and the actor mean', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    render(
      <RoleProvider role="ADMIN">
        <CustomersPage />
      </RoleProvider>,
    );

    expect(
      await screen.findByText('موجودی اولیه، همان‌طور که از ربات قدیمی منتقل شد'),
    ).toBeTruthy();
    expect(screen.getByText('۵٪ هدیهٔ تمدید')).toBeTruthy();
    expect(screen.getAllByText('سیستم').length).toBe(2);

    // Not translated away: an operator's own note and their own address are
    // what they typed and who they are.
    expect(screen.getByText('اصلاح دستی')).toBeTruthy();
    expect(screen.getByText('sam@samsos.org')).toBeTruthy();
    expect(screen.queryByText('legacy balance carried over unchanged')).toBeNull();
    expect(screen.queryByText('SYSTEM')).toBeNull();

    // The order list names the top-up rather than leaving its cell blank.
    expect(await screen.findByText('شارژ کیف پول')).toBeTruthy();
  });
});

describe('the orders and services in a customer’s card', () => {
  it('names the card each order was paid into, and links each account to its panel', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    render(
      <RoleProvider role="ADMIN">
        <CustomersPage />
      </RoleProvider>,
    );

    // The order: which card, and which account it made.
    expect(await screen.findByText('**** **** **** 7613')).toBeTruthy();

    // The service: the same account name, as a link straight onto the panel
    // — in a new tab, so the customer's card stays where the operator was.
    const links = (await screen.findAllByText('reza_7613')).filter((el) => el.tagName === 'A');
    expect(links).toHaveLength(1);
    const link = links[0] as HTMLAnchorElement;
    expect(link.href).toBe('https://pg.example:8000/dashboard/#/users?search=reza_7613');
    expect(link.target).toBe('_blank');

    // No panel to open → a name, never a dead link.
    const old = screen.getByText('old_acct');
    expect(old.tagName).not.toBe('A');
    expect(old.querySelector('a')).toBeNull();
  });
});

describe('«صفر کردن موجودی»', () => {
  it('writes exactly minus the balance, and only after the operator confirms', async () => {
    detail = { ...DETAIL, balanceIrr: 540_000 };
    window.history.replaceState(null, '', '/customers?id=7');
    render(
      <RoleProvider role="ADMIN">
        <CustomersPage />
      </RoleProvider>,
    );
    const button = (await screen.findByText('صفر کردن موجودی')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(button);
    expect(adjustWallet).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(button);
    expect(
      await screen.findByText((t) => t.startsWith('کیف پول اصلاح شد')),
    ).toBeTruthy();
    expect(adjustWallet).toHaveBeenCalledTimes(1);
    expect(adjustWallet.mock.calls[0]?.[1]).toMatchObject({
      amountIrr: -540_000,
      note: 'صفر کردن موجودی',
    });
  });

  it('is disabled when there is nothing to zero', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    render(
      <RoleProvider role="ADMIN">
        <CustomersPage />
      </RoleProvider>,
    );
    const button = (await screen.findByText('صفر کردن موجودی')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
