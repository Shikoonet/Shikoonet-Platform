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
import type { PanelGroups, PanelRef, ServiceRow } from '../src/api.js';

const PANEL: PanelRef = {
  id: 3,
  name: 'پنل تست',
  code: 'test-panel',
  status: 'ACTIVE',
  hasGroups: true,
  // A panel that can actually be reached and logged in to. Both are required
  // on the type on purpose: a fixture that omits them is a screen that never
  // meets the panel this shop has, which is how «گروه ۳ روی پنل نیست» came to
  // be shown for a panel with no address.
  baseUrl: 'https://panel.example:9443',
  hasCredential: true,
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
    rowIndex: null,
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

/**
 * Not every product is delivered by a panel.
 *
 * Sam sold a Spotify account on 2026-08-27, through the `manual` route, and the
 * row said «گروهی انتخاب نشده» twice about a service that was working — because
 * both columns took «no groups» to mean «none were chosen» rather than «this
 * kind has none». The screen also asked the groups endpoint about it, once per
 * render, and got a 404 every time.
 */
describe('a delivery route that has no groups', () => {
  const MANUAL = { ...PANEL, id: 4, name: 'تحویل دستی', code: 'manual-delivery', hasGroups: false };
  const SPOTIFY: ServiceRow = {
    ...service(20, 'اسپاتیفای پریمیوم', [], ['۱ ماهه']),
    kind: 'spotify',
    groupIds: null,
    panel: MANUAL,
  };

  beforeEach(() => {
    catalog.mockImplementation(async () => ({
      ok: true, total: 1, page: 1, pageSize: 25, items: [SPOTIFY], panels: [MANUAL],
    }));
  });

  it('says how it is delivered instead of which groups it failed to name', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-20')).toBeTruthy());
    expect(screen.getByText('تحویل دستی', { selector: '.badge' })).toBeTruthy();
    // The whole point: the warning that was not a warning.
    expect(screen.queryByText('گروهی انتخاب نشده')).toBeNull();
  });

  it('does not ask a groupless route for its groups', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-20')).toBeTruthy());
    // Asserted after the row is on screen, so this cannot pass merely by being
    // checked before the effect had a chance to run.
    expect(panelGroups).not.toHaveBeenCalled();
  });
});

/**
 * The screen Sam was looking at on 2026-08-29.
 *
 * The staging PasarGuard panel is switched ON and has no `base_url` and no
 * credential — a state «مدیریت پنل‌ها» has always drawn correctly («آدرس و رمز
 * ندارد») and this screen could not see at all, because the service row did not
 * carry either fact. So it walked past the panel and reported the next thing it
 * could measure: «گروه ۳ روی پنل نیست». Four rows of five said that, and every
 * one of them sent an operator to the groups screen to fix an address.
 *
 * The fixture is that panel, not an invented one: ACTIVE, `baseUrl: null`,
 * `hasCredential: false`, and services whose group ids the panel has never
 * heard of — because it has never been asked anything.
 */
describe('an ACTIVE panel with nowhere to send a request', () => {
  const UNREACHABLE = { ...PANEL, baseUrl: null, hasCredential: false };
  const ROWS = SERVICES.map((s) => ({ ...s, panel: UNREACHABLE }));

  beforeEach(() => {
    catalog.mockImplementation(async () => ({
      ok: true, total: ROWS.length, page: 1, pageSize: 25, items: ROWS, panels: [UNREACHABLE],
    }));
  });

  it('names the panel and what it is missing, not the groups', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-8')).toBeTruthy());

    expect(screen.getAllByText('فروخته نمی‌شود').length).toBe(ROWS.length);
    expect(screen.getAllByText(/آدرس و رمز ندارد/).length).toBe(ROWS.length);
    // The sentence that was there before, and the screen it sent people to.
    expect(screen.queryByText(/روی پنل نیست/)).toBeNull();
    expect(screen.queryByText('هر خریدی از این سرویس شکست می‌خورد.')).toBeNull();
  });

  it('says which one is missing when only one is', async () => {
    const NO_PASSWORD = { ...PANEL, baseUrl: 'https://panel.example:9443', hasCredential: false };
    catalog.mockImplementation(async () => ({
      ok: true, total: 1, page: 1, pageSize: 25,
      items: [{ ...SERVICES[0]!, panel: NO_PASSWORD }], panels: [NO_PASSWORD],
    }));
    draw();
    await waitFor(() => expect(screen.getByText('svc-8')).toBeTruthy());

    expect(screen.getByText(/رمز ندارد/)).toBeTruthy();
    // Not the both-missing sentence: the fix for one is not the fix for the other.
    expect(screen.queryByText(/آدرس و رمز ندارد/)).toBeNull();
  });

  it('leaves the group column at «—», not at a spinner waiting for nothing', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-8')).toBeTruthy());
    // The request is deliberately never sent, so `data` never arrives. Without
    // its own guard the group cell sits on «…» for as long as the screen is
    // open, which reads as «still loading» and never resolves.
    expect(screen.queryByText('…')).toBeNull();
  });

  it('does not send a request that can only time out', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('svc-8')).toBeTruthy());
    // One doomed request per panel per render is what the practice box cost:
    // eight seconds each, and the answer could never arrive.
    expect(panelGroups).not.toHaveBeenCalled();
  });
});

