/**
 * The two sentences these screens exist to say.
 *
 * `whyNotSellable` is proven against the bot in `apps/bot/test/sellable.test.ts`
 * — that is where the RULE is checked. Nothing here re-checks it. What is
 * checked here is that the screens actually print the answer, because on
 * 2026-08-27 the fault was never in the rule: `provider.status` arrived on every
 * row of both catalogue responses and both screens drew the plan's status
 * instead. A payload carrying the truth and a table drawing something else is a
 * gap only a render test can see.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { ProductsPage } from '../src/pages/ProductsPage.js';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';
import type { CategoryRow, PanelRef, PlanRow } from '../src/api.js';

const LIVE: PanelRef = {
  id: 1,
  name: 'پنل زنده',
  code: 'live',
  status: 'ACTIVE',
  hasGroups: true,
  baseUrl: 'https://panel.example:9443',
  hasCredential: true,
  capacity: null,
  liveSubscriptions: 0,
};
// Named for a place, not for their state: «پنل خاموش» as a fixture name collides
// with the short reason the cell prints, and a test that cannot tell the panel's
// NAME from the panel's VERDICT is not testing the verdict.
const OFF: PanelRef = { ...LIVE, id: 2, name: 'پنل آلمان', code: 'off', status: 'DISABLED' };
const FULL: PanelRef = {
  ...LIVE,
  id: 3,
  name: 'پنل هلند',
  code: 'full',
  capacity: 2,
  liveSubscriptions: 2,
};

function plan(id: number, name: string, provider: PanelRef | null, status = 'ACTIVE'): PlanRow {
  return {
    id,
    name,
    badge: null,
    buttonStyle: null,
    priceIrr: 1_000_000,
    durationDays: 30,
    volumeGb: 10,
    userLimit: null,
    status,
    sortOrder: id,
    rowIndex: null,
    product: {
      id: id * 10,
      code: `svc-${id}`,
      name: `سرویس ${id}`,
      kind: 'vpn',
      status: 'ACTIVE',
      description: null,
      sortOrder: 0,
      categoryId: 1,
      resellersOnly: false,
      oncePerUser: false,
      groupIds: null,
    },
    provider,
    categoryName: 'سرویس‌ها',
    ordersCount: 0,
  };
}

const products = vi.fn();
const productCategories = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      products: (p: unknown) => products(p),
      productCategories: () => productCategories(),
      catalog: async () => ({ items: [] }),
    },
  };
});

function category(over: Partial<CategoryRow>): CategoryRow {
  return {
    id: 1,
    name: 'سرویس‌ها',
    badge: null,
    buttonStyle: null,
    active: true,
    sortOrder: 0,
    rowIndex: null,
    productsCount: 1,
    planCount: 1,
    sellableCount: 1,
    ...over,
  };
}

beforeEach(() => {
  products.mockReset();
  productCategories.mockReset();
  productCategories.mockResolvedValue({ ok: true, items: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('«محصولات» says what the shop can do with a row', () => {
  async function draw(items: PlanRow[], sellableTotal: number) {
    products.mockResolvedValue({
      ok: true,
      total: items.length,
      sellableTotal,
      page: 1,
      pageSize: 25,
      items,
      providers: [],
    });
    render(
      <RoleProvider role="ADMIN">
        <ProductsPage onGo={() => {}} />
      </RoleProvider>,
    );
    await waitFor(() => expect(products).toHaveBeenCalled());
  }

  /**
   * The table, not the page.
   *
   * «فروخته نمی‌شود» and «در فروشگاه» are also the two options of the filter
   * this screen gained, so a page-wide query matches the dropdown and passes
   * whatever the table drew — the exact shape of test that would have missed the
   * original bug.
   */
  const table = () => within(screen.getByRole('table'));

  it('prints the count that matters beside the count that does not', async () => {
    // «۱۶ محصول» said nothing while three were on sale. Both numbers, always.
    await draw([plan(1, 'زنده', LIVE), plan(2, 'مرده', OFF)], 1);
    await waitFor(() => expect(screen.getByText(/۲ محصول/)).toBeTruthy());
    expect(screen.getByText(/۱ قابل خرید/)).toBeTruthy();
  });

  it('names the panel as the reason, not the row', async () => {
    // The fix for a row on a dead panel is «go and switch a panel on», and the
    // row's own status is ACTIVE and says nothing about it.
    await draw([plan(2, 'مرده', OFF)], 0);
    await waitFor(() => expect(table().getByText('فروخته نمی‌شود')).toBeTruthy());
    expect(table().getByText('پنل خاموش')).toBeTruthy();
  });

  it('names a full panel, which no screen could say before', async () => {
    await draw([plan(3, 'روی پنل پر', FULL)], 0);
    await waitFor(() => expect(table().getByText('پنل پر است')).toBeTruthy());
  });

  it('says «در فروشگاه» only when a customer could really buy it', async () => {
    await draw([plan(1, 'زنده', LIVE)], 1);
    await waitFor(() => expect(table().getByText('در فروشگاه')).toBeTruthy());
    expect(table().queryByText('فروخته نمی‌شود')).toBeNull();
  });

  it('names both faults when a row has two', async () => {
    await draw([plan(4, 'هم پنهان هم روی پنل مرده', OFF, 'HIDDEN')], 0);
    await waitFor(() => expect(table().getByText(/پنل خاموش · پنهان/)).toBeTruthy());
  });
});

describe('«دسته‌بندی‌ها» explains what it does', () => {
  async function draw(items: CategoryRow[]) {
    productCategories.mockResolvedValue({ ok: true, items });
    render(
      <RoleProvider role="ADMIN">
        <CategoriesPage />
      </RoleProvider>,
    );
    await waitFor(() => expect(productCategories).toHaveBeenCalled());
  }

  it('says the bot will SKIP this screen when only one category sells anything', async () => {
    // The exact thing that happened: two categories on screen, «در فروشگاه» on
    // both, and a bot that showed neither. `handle.ts:1188` skips a one-choice
    // screen, which is right, and until now nothing anywhere said so.
    await draw([
      category({ id: 1, name: 'سرویس‌ها', sellableCount: 3, planCount: 3 }),
      category({ id: 2, name: 'اکانت‌ها', sellableCount: 0, planCount: 2 }),
    ]);
    await waitFor(() => expect(screen.getByText(/ربات این صفحه را رد می‌کند/)).toBeTruthy());
    expect(screen.getByText(/«سرویس‌ها»/)).toBeTruthy();
  });

  it('says the screen appears once two categories have something to sell', async () => {
    await draw([
      category({ id: 1, name: 'سرویس‌ها', sellableCount: 3, planCount: 3 }),
      category({ id: 2, name: 'اکانت‌ها', sellableCount: 2, planCount: 2 }),
    ]);
    await waitFor(() => expect(screen.getByText(/۲ دکمه/)).toBeTruthy());
  });

  it('warns on a category that is «در فروشگاه» and invisible in the shop', async () => {
    await draw([category({ id: 2, name: 'اکانت‌ها', sellableCount: 0, planCount: 2 })]);
    await waitFor(() => expect(screen.getByText('در ربات دیده نمی‌شود')).toBeTruthy());
  });

  it('says the shop is empty rather than showing nothing', async () => {
    // An empty screen is an invitation to act, and the likely cause is named.
    await draw([category({ id: 1, sellableCount: 0, planCount: 0, productsCount: 0 })]);
    await waitFor(() => expect(screen.getByText(/فروشگاه در ربات خالی است/)).toBeTruthy());
  });

  /*
   * Seen live on 2026-08-27: the route answered 500 and the page reported
   * «هیچ دسته‌بندی‌ای چیز خریدنی ندارد» and «هنوز دسته‌بندی‌ای ساخته نشده» —
   * both stated as fact, both derived from an empty `rows` that only meant the
   * request had failed. A screen that cannot tell «zero» from «I do not know»
   * lies most confidently exactly when it knows least.
   */
  it('reports the failure instead of describing a shop it could not read', async () => {
    productCategories.mockRejectedValue(new Error('500'));
    render(
      <RoleProvider role="ADMIN">
        <CategoriesPage />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    expect(screen.queryByText(/فروشگاه در ربات خالی است/)).toBeNull();
    expect(screen.queryByText(/هنوز دسته‌بندی‌ای ساخته نشده/)).toBeNull();
  });
});
