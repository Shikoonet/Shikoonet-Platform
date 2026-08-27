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

const PANEL = {
  id: 3,
  name: 'پنل تست',
  code: 'test-panel',
  status: 'ACTIVE',
  capacity: null,
  liveSubscriptions: 0,
};

function service(
  id: number,
  name: string,
  groupIds: number[],
  configs: string[],
): ServiceRow {
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
    groupIds,
    panel: PANEL,
    configs: configs.map((cfName, i) => ({
      id: id * 100 + i,
      name: cfName,
      badge: null,
      priceIrr: 1_000_000 * (i + 1),
      volumeGb: 10 * (i + 1),
      durationDays: 30,
      userLimit: null,
      rowIndex: null,
      status: 'ACTIVE',
      sortOrder: i,
      ordersCount: 0,
    })),
  };
}

const SERVICES = [
  service(8, 'پلاتینیوم', [6], ['۱ ماهه - ۱۰ گیگ', '۱ ماهه - ۲۰ گیگ', '۱ ماهه - ۳۰ گیگ']),
  service(9, 'طلایی', [7], ['۱ ماهه - ۱۰ گیگ']),
  // Two groups at once — the shape the live panel had, where four of these
  // rendered inline and came out as one four-digit number.
  service(10, 'همه‌کاره', [6, 7], ['۱ ماهه - ۵۰ گیگ']),
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
    expect(screen.getAllByText(/^svc-/)).toHaveLength(SERVICES.length);

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
    expect(screen.getAllByText('#6').length).toBeGreaterThan(0);
  });

  it('says on the row when a service can deliver nothing', async () => {
    // طلایی's one inbound has no host. The group exists, the service is ACTIVE,
    // the customer pays and receives nothing — and until this column existed
    // the only way to find out was to buy one.
    draw();
    // Waits for the SENTENCE, not for the service name beside it. The name
    // arrives with the catalogue fetch; the delivery column is filled by a
    // second, later call to `panelGroups`. Waiting for the name and then
    // reading the column synchronously passed alone and failed in a full run —
    // a test that is green on a fast machine and red on a loaded one is not
    // evidence, it is a coin toss with a comment on it.
    expect((await screen.findAllByText('هیچ کانفیگی نمی‌دهد')).length).toBeGreaterThan(0);
  });

  it('keeps each group of a multi-group service on its own line', async () => {
    // Found by walking the deployed panel on 2026-08-24, not by a test: a
    // service on four groups printed «۱۲۲۱» in the «تحویل» column — four
    // separate inbound counts with nothing between them, read as one number, in
    // the column whose whole job is to say whether a customer receives anything.
    draw();
    const row = await screen.findByText('همه‌کاره');
    const cell = () => row.closest('tr')!.querySelectorAll('td')[3]!;

    // Every assertion inside the wait, for the same reason as the test above:
    // the group names come from a second fetch, and the row exists before they
    // do. Retrying the whole group also means the first assertion cannot pass
    // against half-arrived data and the next one fail against the other half.
    await waitFor(() => {
      const delivery = cell().textContent ?? '';
      expect(delivery).toContain('پلاتینیوم:');
      expect(delivery).toContain('طلایی:');
      // The unit is spelled out, because a bare «۲» under «تحویل» says nothing.
      expect(delivery).toContain('۲ اینباند');
      // And the counts are not glued together.
      expect(delivery).not.toMatch(/۲۱|۱۲/);
    });
  });

  it('asks each panel for its groups once, however many services sit on it', async () => {
    draw();
    await waitFor(() => expect(panelGroups).toHaveBeenCalled());
    // Two services, one panel. A call per row would be a call per service.
    expect(panelGroups).toHaveBeenCalledTimes(1);
  });
});
