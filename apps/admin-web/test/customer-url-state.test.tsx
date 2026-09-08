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

const SECOND: CustomerListItem = { ...LIST[0]!, id: 9, telegramId: 555_000, username: 'sara_m' };

const customers = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 2,
  page: 1,
  pageSize: 25,
  items: [...LIST, SECOND],
}));
const customer = vi.fn(async (id: number) => ({
  ok: true,
  customer: { ...DETAIL, id, telegramId: id === 9 ? 555_000 : DETAIL.telegramId },
  entries: [],
}));
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

const EMPTY_PAGE = { ok: true, total: 0, page: 1, pageSize: 10, items: [] };

afterEach(() => {
  customers.mockClear();
  customer.mockClear();
  // `mockReset`, not `mockClear`: one test below replaces the implementation
  // to hold a request open, and a leaked promise that never settles turns
  // every later test into a five-second timeout with no explanation.
  orders.mockReset();
  orders.mockResolvedValue(EMPTY_PAGE as never);
  subscriptions.mockReset();
  subscriptions.mockResolvedValue(EMPTY_PAGE as never);
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
    fireEvent.click((await screen.findAllByRole('button', { name: 'مدیریت' }))[0]!);
    await screen.findByText('تخفیف دائمی');
    expect(window.location.search).toBe('?id=7');
    // Still «کاربران» — this is a card in the page, not a new section.
    expect(window.location.pathname).toBe('/customers');
  });

  it('closes the card when the browser goes Back, rather than leaving the section', async () => {
    draw();
    fireEvent.click((await screen.findAllByRole('button', { name: 'مدیریت' }))[0]!);
    await screen.findByText('تخفیف دائمی');

    // What the Back button does: the address loses `?id=`, then `popstate`.
    window.history.replaceState(null, '', '/customers');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(screen.queryByText('تخفیف دائمی')).toBeNull());
  });

  it('drops the id from the address when «بستن» is pressed', async () => {
    draw();
    fireEvent.click((await screen.findAllByRole('button', { name: 'مدیریت' }))[0]!);
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

describe('two customers, one card', () => {
  it('ignores an answer that arrives for the customer who is no longer open', async () => {
    /*
     * The race the drawer has by construction: it does not remount when `id`
     * changes — it is the same component with a new prop — so a slow answer
     * for customer A can land after B is on screen and paint A's orders under
     * B's name. Nothing about the result looks wrong, which is what makes it
     * worth a test.
     */
    type OrdersPage = Awaited<ReturnType<typeof orders>>;
    const slow = new Map<number, (v: OrdersPage) => void>();
    orders.mockImplementation(
      (p: unknown) =>
        new Promise<OrdersPage>((resolve) =>
          slow.set((p as { customerId: number }).customerId, resolve),
        ),
    );

    draw();
    fireEvent.click((await screen.findAllByRole('button', { name: 'مدیریت' }))[0]!);
    await waitFor(() => expect(slow.has(7)).toBe(true));

    // Switch to the other customer before the first answer comes back.
    fireEvent.click((await screen.findAllByRole('button', { name: 'مدیریت' }))[1]!);
    await waitFor(() => expect(slow.has(9)).toBe(true));

    // Now let the STALE one land, last.
    slow.get(9)!({ ok: true, total: 1, page: 1, pageSize: 10, items: [] });
    slow.get(7)!({
      ok: true,
      total: 99,
      page: 1,
      pageSize: 10,
      items: [],
    });

    // The heading counts the orders of whoever is on screen. «۹۹» is customer
    // 7's number, and customer 9 is the one open — so the heading carrying it
    // is the whole defect, visible and wrong.
    /*
     * Settled, not polled.
     *
     * `waitFor` retries until the assertion holds, and it holds immediately —
     * the stale answer has not landed yet. So the first version of this passed
     * with the guard DELETED, which is the silent kind of green. Letting both
     * promises finish first makes the assertion about what the screen settles
     * on rather than about how fast it is read.
     */
    await new Promise((r) => setTimeout(r, 30));
    const heading = () => screen.getByRole('heading', { name: /^سفارش‌ها/ }).textContent ?? '';
    expect(heading()).not.toContain('۹۹');
    // And positively: the count on screen is the one customer 9's answer
    // carried, not the one that arrived after it for somebody else.
    expect(heading()).toBe('سفارش‌ها (۱)');
  });
});

describe('the links out of the card', () => {
  it('names the customer exactly, never as a search fragment', async () => {
    window.history.replaceState(null, '', '/customers?id=7');
    orders.mockResolvedValue({
      ok: true,
      total: 12,
      page: 1,
      pageSize: 10,
      items: [],
    } as never);
    draw();

    const link = await screen.findByRole('link', { name: /همهٔ .* سفارش/ });
    // `?q=` is a FRAGMENT match: it would also return an order whose public id
    // contains these digits, and another customer whose username contains
    // this one's. «همهٔ ۱۲ سفارش» has to be twelve.
    expect(link.getAttribute('href')).toBe('/orders?customerId=7');
    expect(link.getAttribute('href')).not.toContain('q=');
  });
});
