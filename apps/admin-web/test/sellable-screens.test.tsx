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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CatalogPage } from '../src/pages/CatalogPage.js';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';
import type { CategoryRow, PanelRef, ServiceRow } from '../src/api.js';

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
// ACTIVE, with an address and no credential: the state PanelsPage flags and the
// bot refuses to sell from (#182). A shelf in the same state is fine — it
// never logs in to anything — which is what `hasGroups: false` says.
const UNWIRED: PanelRef = { ...LIVE, id: 4, name: 'پنل فرانسه', code: 'unwired', hasCredential: false };
const SHELF: PanelRef = {
  ...LIVE,
  id: 5,
  name: 'قفسه',
  code: 'shelf',
  hasGroups: false,
  baseUrl: null,
  hasCredential: false,
};

function service(
  id: number,
  name: string,
  panel: PanelRef | null,
  status = 'ACTIVE',
  productStatus = 'ACTIVE',
): ServiceRow {
  return {
    id: id * 10,
    code: `svc-${id}`,
    name: `سرویس ${id}`,
    kind: 'vpn',
    status: productStatus,
    description: null,
    deliveryNote: null,
    sortOrder: 0,
    categoryId: 1,
    categoryName: 'سرویس‌ها',
    categoryActive: true,
    resellersOnly: false,
    oncePerUser: false,
    groupIds: null,
    rowIndex: null,
    badge: null,
    buttonStyle: null,
    panel,
    configs: [
      {
        id,
        name,
        badge: null,
        buttonStyle: null,
        deliveryNote: null,
        priceIrr: 1_000_000,
        durationDays: 30,
        volumeGb: 10,
        userLimit: null,
        status,
        sortOrder: id,
        rowIndex: null,
        ordersCount: 0,
      },
    ],
  };
}

const catalog = vi.fn();
const productCategories = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      catalog: (p: unknown) => catalog(p),
      productCategories: () => productCategories(),
      // A live panel is asked for its groups; the verdicts here do not depend on the answer.
      panelGroups: async () => ({ ok: true, selected: [], available: [], plans: [], inherit: [] }),
      emojiPacks: async () => ({ ok: true, customEmoji: false, packs: [] }),
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
  catalog.mockReset();
  productCategories.mockReset();
  productCategories.mockResolvedValue({ ok: true, items: [] });
});
afterEach(() => vi.restoreAllMocks());

/**
 * «محصولات» became «نمای جدولی» of «سرویس‌ها» on 2026-09-13. Same verdicts,
 * same column; the page that owned the service's status is now the page
 * these rows are on, so the link to it went away with the reason for it.
 */
describe('«نمای جدولی» says what the shop can do with a row', () => {
  async function draw(items: ServiceRow[], sellableTotal: number) {
    catalog.mockResolvedValue({
      ok: true,
      total: items.length,
      configsTotal: items.length,
      sellableTotal,
      page: 1,
      pageSize: 25,
      items,
      panels: [],
    });
    window.history.replaceState({}, '', '/?view=table');
    render(
      <RoleProvider role="ADMIN">
        <CatalogPage />
      </RoleProvider>,
    );
    await waitFor(() => expect(catalog).toHaveBeenCalled());
  }

  afterEach(() => window.history.replaceState({}, '', '/'));

  /**
   * The table, not the page.
   *
   * «فروخته نمی‌شود» and «در فروشگاه» could also appear in a filter, so a
   * page-wide query would pass whatever the table drew — the exact shape of
   * test that would have missed the original bug.
   */
  const table = () => within(screen.getByRole('table'));

  it('prints the count that matters beside the count that does not', async () => {
    // «۱۶ محصول» said nothing while three were on sale. Both numbers, always.
    await draw([service(1, 'زنده', LIVE), service(2, 'مرده', OFF)], 1);
    await waitFor(() => expect(screen.getByText(/۲ سرویس/)).toBeTruthy());
    expect(screen.getByText(/۱ قابل خرید/)).toBeTruthy();
  });

  it('names the panel as the reason, not the row', async () => {
    await draw([service(2, 'مرده', OFF)], 0);
    await waitFor(() => expect(table().getByText('فروخته نمی‌شود')).toBeTruthy());
    expect(table().getByText('پنل خاموش')).toBeTruthy();
  });

  it('names a full panel, which no screen could say before', async () => {
    await draw([service(3, 'روی پنل پر', FULL)], 0);
    await waitFor(() => expect(table().getByText('پنل پر است')).toBeTruthy());
  });

  it('names a panel the bot cannot log in to, and leaves a shelf alone', async () => {
    await draw([service(4, 'روی پنل بی‌اعتبارنامه', UNWIRED), service(5, 'روی قفسه', SHELF)], 1);
    await waitFor(() => expect(table().getByText('پنل وصل نیست')).toBeTruthy());
    expect(table().getByText('در فروشگاه')).toBeTruthy();
  });

  it('says «در فروشگاه» only when a customer could really buy it', async () => {
    await draw([service(1, 'زنده', LIVE)], 1);
    await waitFor(() => expect(table().getByText('در فروشگاه')).toBeTruthy());
    expect(table().queryByText('فروخته نمی‌شود')).toBeNull();
  });

  it('names the CATEGORY as the reason when the shelf is the thing that is off', async () => {
    // Three green things and a product nobody can buy — the one reason the
    // row itself shows nothing of. `categoryActive` is the ONLY difference
    // from the healthy row above.
    await draw([{ ...service(6, 'زیر دستهٔ خاموش', LIVE), categoryActive: false }], 0);
    await waitFor(() => expect(table().getByText('فروخته نمی‌شود')).toBeTruthy());
    expect(table().getByText('دسته خاموش')).toBeTruthy();
    expect(table().queryByText('در فروشگاه')).toBeNull();
  });

  it('names both faults when a row has two', async () => {
    await draw([service(4, 'هم پنهان هم روی پنل مرده', OFF, 'HIDDEN')], 0);
    await waitFor(() => expect(table().getByText(/پنل خاموش · پنهان/)).toBeTruthy());
  });

  it('opens the service editor from the row for the fault only the service can fix', async () => {
    // «سرویس پنهان» used to send the operator to another page. The page is
    // this one; the row's «سرویس» opens the editor that owns the status.
    await draw([service(5, 'کانفیگ زنده', LIVE, 'ACTIVE', 'HIDDEN')], 0);
    await waitFor(() => expect(table().getByText('سرویس پنهان')).toBeTruthy());
    fireEvent.click(table().getByRole('button', { name: 'سرویس' }));
    expect((screen.getByLabelText('نام سرویس') as HTMLInputElement).value).toBe('سرویس 5');
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
