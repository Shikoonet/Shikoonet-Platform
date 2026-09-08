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
import { render, screen } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CustomersPage } from '../src/pages/CustomersPage.js';
import type { CustomerDetail, CustomerListItem } from '../src/api.js';

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

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      customers: async () => ({ ok: true, total: 1, page: 1, pageSize: 25, items: LIST }),
      customer: async () => ({ ok: true, customer: DETAIL, entries: ENTRIES }),
      orders: async () => ({ ok: true, total: 0, page: 1, pageSize: 10, items: [] }),
      subscriptions: async () => ({ ok: true, total: 0, page: 1, pageSize: 10, items: [] }),
      customerHistory: async () => ({ ok: true, items: [] }),
    },
  };
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
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
  });
});
