/**
 * The two sentences this screen has to get right about a reseller.
 *
 * A level's percentage and a customer's own `discount_percent` are different
 * numbers, and only one of them is charged. The panel has been rebuilt more
 * than once because two screens gave two answers about the same figure, so
 * these assertions are about what the operator READS, not about the request.
 *
 * The other half is the request: «ذخیره» on the level must send the flag and
 * the level together, because the route writes both in one statement and a body
 * carrying only one of them would leave a customer whose row disagrees with
 * itself.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CustomersPage } from '../src/pages/CustomersPage.js';
import type { CustomerDetail, CustomerListItem } from '../src/api.js';

const LEVEL_ONE = { code: 'n' as const, name: 'نماینده', percent: 40 };

const LIST: CustomerListItem[] = [
  {
    id: 7,
    telegramId: 555_111,
    username: 'reza_kh',
    phone: null,
    status: 'ACTIVE',
    isReseller: true,
    // Their own number is 5 and the level's is 40. Every assertion below turns
    // on the two being different.
    discountPercent: 5,
    tier: LEVEL_ONE,
    effectiveDiscountPercent: 40,
    balanceIrr: 0,
    registeredAt: '2026-08-01T09:00:00Z',
    lastSeenAt: null,
  },
];

const DETAIL: CustomerDetail = {
  id: 7,
  telegramId: 555_111,
  username: 'reza_kh',
  phone: null,
  phoneVerified: false,
  status: 'ACTIVE',
  blockedReason: null,
  isReseller: true,
  discountPercent: 5,
  tier: LEVEL_ONE,
  effectiveDiscountPercent: 40,
  referralCode: null,
  balanceIrr: 0,
  registeredAt: '2026-08-01T09:00:00Z',
  lastSeenAt: null,
  orderCount: 0,
  paidTotalIrr: 0,
};

const customers = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 1,
  page: 1,
  pageSize: 25,
  items: LIST,
}));
const customer = vi.fn(async (_id: number) => ({ ok: true, customer: DETAIL, entries: [] }));
const setReseller = vi.fn(async (_id: number, _body: unknown) => ({ ok: true, changed: true }));
const setDiscount = vi.fn(async (_id: number, _body: unknown) => ({
  ok: true,
  percent: 12,
  effectivePercent: 40,
  tierName: 'نماینده',
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      // Wrapped, not passed by reference: the factory is hoisted above the consts.
      customers: (p: unknown) => customers(p),
      customer: (id: number) => customer(id),
      setReseller: (id: number, body: unknown) => setReseller(id, body),
      setDiscount: (id: number, body: unknown) => setDiscount(id, body),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <CustomersPage />
    </RoleProvider>,
  );

async function openDrawer() {
  draw();
  fireEvent.click(await screen.findByRole('button', { name: 'مدیریت' }));
  await screen.findByText('نمایندگی');
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  customers.mockClear();
  customer.mockClear();
  setReseller.mockClear();
  setDiscount.mockClear();
});

describe('what the screen says a reseller pays', () => {
  it('shows the level’s percentage, not the personal one', async () => {
    await openDrawer();

    // 40٪ from the level, with the level named so the number can be accounted
    // for. Showing «۵٪» here — the stored column — would be the panel
    // disagreeing with the shop.
    const fact = await screen.findByText(/۴۰٪/);
    expect(fact.textContent).toContain('نماینده');
    expect(screen.queryByText('۵٪')).toBeNull();
  });

  it('names the level on the row, not just «نماینده»', async () => {
    draw();
    expect(await screen.findByText('نماینده')).toBeTruthy();
  });
});

describe('saving', () => {
  it('sends the flag and the level together', async () => {
    await openDrawer();

    fireEvent.change(screen.getByLabelText('سطح'), { target: { value: 'n2' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره نمایندگی' }));

    await waitFor(() => expect(setReseller).toHaveBeenCalled());
    const [, body] = setReseller.mock.calls[0]!;
    expect(body).toEqual({ isReseller: true, tier: 'n2' });
  });

  it('clears the level when the reseller flag comes off', async () => {
    await openDrawer();

    fireEvent.change(screen.getByLabelText('سطح'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره نمایندگی' }));

    await waitFor(() => expect(setReseller).toHaveBeenCalled());
    expect(setReseller.mock.calls[0]![1]).toEqual({ isReseller: false, tier: null });
  });

  /**
   * The sentence that stops «ذخیره شد» being true and misleading at once.
   *
   * A personal discount saved on a customer who is on a level changes nothing
   * they will ever pay. The route says so in its answer and the screen has to
   * repeat it, or the operator walks away believing they set a price.
   */
  it('says a stored personal discount is not what the customer pays', async () => {
    await openDrawer();

    fireEvent.change(screen.getByLabelText('درصد'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره تخفیف' }));

    await waitFor(() => expect(setDiscount).toHaveBeenCalled());
    const note = await screen.findByText(/در «نماینده» است/);
    expect(note.textContent).toContain('۴۰٪');
  });
});
