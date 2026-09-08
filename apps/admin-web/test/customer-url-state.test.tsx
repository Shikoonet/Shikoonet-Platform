/**
 * A customer you can send someone a link to.
 *
 * «مدیریت» opened a card that existed nowhere in the address bar, so the only
 * way to show a colleague a customer was to describe the search that finds
 * them. Everything here is about the address bar and the Back button, which is
 * the half a `useState` drawer cannot have:
 *
 *  * `?id=` on arrival opens the card without a click — that is what makes a
 *    pasted link work at all.
 *  * pressing «مدیریت» writes `?id=` — that is what makes the link exist.
 *  * Back closes the card instead of leaving the section, because `popstate`
 *    is read rather than ignored.
 *  * the card asks for that customer's OWN orders and services, by
 *    `customerId` — the exact filter, not the `q` fragment match that would
 *    also match a different customer whose username contains theirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  orderCount: 2,
  paidTotalIrr: 1_000_000,
};

const customers = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 1,
  page: 1,
  pageSize: 25,
  items: LIST,
}));
const customer = vi.fn(async (_id: number) => ({ ok: true, customer: DETAIL, entries: [] }));
const orders = vi.fn(async (_p: unknown) => ({ ok: true, total: 0, page: 1, pageSize: 10, items: [] }));
const subscriptions = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 0,
  page: 1,
  pageSize: 10,
  items: [],
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      customers: (p: unknown) => customers(p),
      customer: (id: number) => customer(id),
      orders: (p: unknown) => orders(p),
      subscriptions: (p: unknown) => subscriptions(p),
      customerHistory: async () => ({ ok: true, items: [] }),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <CustomersPage />
    </RoleProvider>,
  );

beforeEach(() => {
  window.history.replaceState(null, '', '/customers');
});

afterEach(() => {
  customers.mockClear();
  customer.mockClear();
  orders.mockClear();
  subscriptions.mockClear();
  window.history.replaceState(null, '', '/');
});

describe('a customer in the address bar', () => {
  it('opens the card from `?id=` without anybody pressing a button', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    draw();
    await waitFor(() => expect(customer).toHaveBeenCalledWith(7));
    expect(await screen.findByText('تخفیف دائمی')).toBeTruthy();
  });

  it('writes the id into the address bar when the card is opened by hand', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'مدیریت' }));
    await screen.findByText('تخفیف دائمی');
    expect(window.location.search).toBe('?id=7');
    // Still «کاربران» — this is a card in the page, not a new section.
    expect(window.location.pathname).toBe('/customers');
  });

  it('closes the card when the browser goes Back, rather than leaving the section', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'مدیریت' }));
    await screen.findByText('تخفیف دائمی');

    // What the Back button does: the address loses `?id=`, then `popstate`.
    window.history.replaceState(null, '', '/customers');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(screen.queryByText('تخفیف دائمی')).toBeNull());
  });

  it('drops the id from the address when «بستن» is pressed', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'مدیریت' }));
    await screen.findByText('تخفیف دائمی');
    // Proving the address really carried it, so the assertion below is about
    // «بستن» clearing it rather than about it never having been there.
    expect(window.location.search).toBe('?id=7');
    fireEvent.click(screen.getByRole('button', { name: 'بستن' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('asks for this customer’s own orders and services, by the exact id', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    draw();
    await waitFor(() => expect(orders).toHaveBeenCalled());
    expect(orders.mock.calls[0]![0]).toMatchObject({ customerId: 7, page: 1, pageSize: 10 });
    expect(subscriptions.mock.calls[0]![0]).toMatchObject({ customerId: 7, page: 1, pageSize: 10 });
  });
});
