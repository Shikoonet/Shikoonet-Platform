/**
 * The first thing the dashboard should say.
 *
 * It opened with six aggregates — customers, revenue, active services — and
 * nothing about what was waiting, so the first act of every morning was
 * visiting «پرداخت‌ها», «لیست درخواست‌ها», «دستگاه‌ها» and «مدیریت پنل‌ها» to
 * find out whether there was anything to do. The 2026-09-07 walk called that
 * the difference between a dashboard that reports and one that works.
 *
 * Every chip is asserted on WHERE IT GOES as well as what it says: a number
 * that cannot be acted on from the screen it is printed on is a number the
 * operator has to go and find again.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DashboardPage } from '../src/pages/DashboardPage.js';
import { RoleProvider } from '../src/role.js';

const BASE = {
  ok: true,
  customers: 11_241,
  customersToday: 3,
  activeSubscriptions: 800,
  revenueIrr: 1_000_000,
  revenueAdjustmentIrr: 0,
  ordersToday: 4,
  walletHeldIrr: 0,
  walletOwedToShopIrr: 0,
  walletDebtors: 0,
  recentCustomers: [],
  recentOrders: [],
};

const overview = vi.fn(async () => ({
  ...BASE,
  attention: {
    openClaims: 6,
    pendingRequests: 171,
    expiringSubscriptions7d: 12,
    staleDevices: 0,
    panelsWithoutSecret: 1,
  },
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return { ...actual, api: { overview: () => overview() } };
});

const draw = (onGo = vi.fn()) => {
  render(
    <RoleProvider role="ADMIN">
      <DashboardPage onGo={onGo} />
    </RoleProvider>,
  );
  return onGo;
};

afterEach(() => {
  overview.mockClear();
});

describe('what needs attention, on the dashboard', () => {
  it('prints each queue with its count, in the panel’s digits', async () => {
    draw();
    expect(await screen.findByText(/پرداخت در انتظار/)).toBeTruthy();
    // ۱۷۱, not 171 — every other number on this screen is Persian.
    expect(screen.getByText(/۱۷۱/)).toBeTruthy();
    expect(screen.getByText(/۱۲/)).toBeTruthy();
  });

  it('sends the operator to the screen that clears it', async () => {
    const onGo = draw();
    fireEvent.click(await screen.findByRole('button', { name: /پرداخت در انتظار/ }));
    // The payments screen ON the open tab — the queue, not the default view.
    expect(onGo).toHaveBeenCalledWith('payments', '?tab=open');

    fireEvent.click(screen.getByRole('button', { name: /درخواست نمایندگی/ }));
    expect(onGo).toHaveBeenCalledWith('requests');
  });

  it('says nothing is waiting, rather than printing five zeros', async () => {
    overview.mockResolvedValueOnce({
      ...BASE,
      attention: {
        openClaims: 0,
        pendingRequests: 0,
        expiringSubscriptions7d: 0,
        staleDevices: 0,
        panelsWithoutSecret: 0,
      },
    });
    draw();
    expect(await screen.findByText('چیزی در انتظار نیست.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /پرداخت در انتظار/ })).toBeNull();
  });

  it('draws only the queues that have something in them', async () => {
    draw();
    // `staleDevices` is 0 in the fixture: a chip reading «۰ دستگاه خاموش» is a
    // line the eye has to read before discarding, on a screen whose job is to
    // be scanned.
    expect(await screen.findByText(/پنل بی‌رمز/)).toBeTruthy();
    expect(screen.queryByText(/دستگاه خاموش/)).toBeNull();
  });
});
