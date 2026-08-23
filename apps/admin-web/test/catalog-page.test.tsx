/**
 * The catalogue screen, asked the one question the old one got wrong.
 *
 * `ProductsPage` drew one row per PLAN. A service with three configs was three
 * rows that repeated its name in grey, the service itself was never a row, and
 * the only way to reach it was to open one of its plans. This asserts the
 * inversion: one row per SERVICE, its configs inside it and not before it.
 *
 * The fixture is the live test panel on 2026-08-24 — three services, one panel,
 * one group each — so the numbers here are the ones on the screen Sam is
 * looking at rather than invented ones.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CatalogPage } from '../src/pages/CatalogPage.js';
import type { PanelGroups, ServiceRow } from '../src/api.js';

const PANEL = { id: 3, name: 'پنل تست', code: 'test-panel', status: 'ACTIVE' };

function service(id: number, name: string, groupId: number, configs: string[]): ServiceRow {
  return {
    id,
    code: `svc-${id}`,
    name,
    kind: 'vpn',
    status: 'ACTIVE',
    description: null,
    sortOrder: id,
    categoryId: null,
    categoryName: null,
    resellersOnly: false,
    oncePerUser: false,
    groupIds: [groupId],
    panel: PANEL,
    configs: configs.map((cfName, i) => ({
      id: id * 100 + i,
      name: cfName,
      priceIrr: 1_000_000 * (i + 1),
      volumeGb: 10 * (i + 1),
      durationDays: 30,
      userLimit: null,
      status: 'ACTIVE',
      sortOrder: i,
      ordersCount: 0,
    })),
  };
}

const SERVICES = [
  service(8, 'پلاتینیوم', 6, ['۱ ماهه - ۱۰ گیگ', '۱ ماهه - ۲۰ گیگ', '۱ ماهه - ۳۰ گیگ']),
  service(9, 'طلایی', 7, ['۱ ماهه - ۱۰ گیگ']),
];

const GROUPS: PanelGroups = {
  ok: true,
  selected: [6, 7],
  available: [
    { id: 6, name: 'پلاتینیوم', inboundTags: ['Shadowsocks TCP', 'VLESS TCP'], deliverableInbounds: 2 },
    { id: 7, name: 'طلایی', inboundTags: ['Shadowsocks TCP'], deliverableInbounds: 0 },
  ] as PanelGroups['available'],
  plans: [],
  inherit: [],
};

const catalog = vi.fn(async (_params: unknown) => ({
  ok: true,
  total: SERVICES.length,
  page: 1,
  pageSize: 25,
  items: SERVICES,
  panels: [PANEL],
}));
const panelGroups = vi.fn(async (_id: number) => GROUPS);

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      catalog: (p: unknown) => catalog(p),
      panelGroups: (id: number) => panelGroups(id),
      productCategories: async () => ({ ok: true, items: [] }),
    },
  };
});

function draw() {
  render(
    <RoleProvider role="ADMIN">
      <CatalogPage />
    </RoleProvider>,
  );
}

beforeEach(() => {
  catalog.mockClear();
  panelGroups.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('the catalogue screen', () => {
  it('draws one row per service, not one per config', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-8')).toBeTruthy());

    // Counted on the code sub-line, which appears exactly once per service row
    // and never on a config. Four configs across two services: row-per-plan
    // would be four rows, row-per-service is two.
    expect(screen.getAllByText(/^svc-/)).toHaveLength(2);

    // The configs are NOT on screen until the service is opened.
    expect(screen.queryByText('۱ ماهه - ۲۰ گیگ')).toBeNull();
  });

  it('opens a service onto its own configs', async () => {
    draw();
    const toggle = await screen.findByRole('button', { name: /۳ کانفیگ/ });
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText('۱ ماهه - ۲۰ گیگ')).toBeTruthy());
    expect(screen.getByText('۱ ماهه - ۳۰ گیگ')).toBeTruthy();
    // Prices are Toman on screen and Rial on the wire.
    expect(screen.getByText('۲۰۰٬۰۰۰ تومان')).toBeTruthy();
  });

  it('names the group rather than printing its id', async () => {
    draw();
    // The old screen showed `[6]`. «پلاتینیوم» is what an operator can act on.
    await waitFor(() => expect(screen.getAllByText('پلاتینیوم').length).toBeGreaterThan(1));
    // Latin, like every other id on this panel — it is what PasarGuard's own UI shows.
    expect(screen.getByText('#6')).toBeTruthy();
  });

  it('says on the row when a service can deliver nothing', async () => {
    // طلایی's one inbound has no host. The group exists, the service is ACTIVE,
    // the customer pays and receives nothing — and until this column existed
    // the only way to find out was to buy one.
    draw();
    await waitFor(() => expect(screen.getByText('طلایی')).toBeTruthy());
    expect(screen.getByText('هیچ کانفیگی نمی‌دهد')).toBeTruthy();
  });

  it('asks each panel for its groups once, however many services sit on it', async () => {
    draw();
    await waitFor(() => expect(panelGroups).toHaveBeenCalled());
    // Two services, one panel. A call per row would be a call per service.
    expect(panelGroups).toHaveBeenCalledTimes(1);
  });
});
