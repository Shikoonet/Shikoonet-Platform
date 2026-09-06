/**
 * What «مدیریت پنل‌ها» says about a panel nobody can sync.
 *
 * The screen already said «تحویل نمی‌دهد — رمز ندارد», which reads as a setup
 * step somebody will get to. On staging, 2026-09-03, five panels in that state
 * held 4,805 of the shop's 4,942 live services: no expiry, no usage, no fresh
 * subscription link since the import, and the only place it was said was the
 * bot's log — twenty `sync.panel_skipped` lines in six hours (issue #112).
 *
 * So the assertions are about the NUMBER, not the badge. A panel that cannot be
 * reached and has nobody on it is a configuration detail; the same panel with
 * two thousand live services on it is customers, and no screen was saying so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { PanelsPage } from '../src/pages/PanelsPage.js';
import type { PanelItem } from '../src/api.js';

function panel(over: Partial<PanelItem>): PanelItem {
  return {
    id: 1,
    code: 'p1',
    name: 'پنل یک',
    kind: 'pasarguard',
    status: 'ACTIVE',
    baseUrl: 'https://p1.example:9443',
    capacity: null,
    sortOrder: 1,
    renewMode: 'RESET',
    extraVolumeMinGb: null,
    extraTimeMinDays: null,
    newcomersOnly: false,
    renewEnabled: true,
    usernameMode: 'TELEGRAM_ID',
    usernameText: null,
    trial: { enabled: false, volumeGb: null, durationHours: null },
    extraVolumeTomanPerGb: { f: null, n: null, n2: null },
    extraTimeTomanPerDay: { f: null, n: null, n2: null },
    downgradeGroupIds: [],
    hasSecretRef: true,
    productCount: 0,
    planCount: 0,
    liveSubscriptions: 0,
    ...over,
  };
}

const panels = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      panels: () => panels(),
      panelGroups: async () => ({ ok: true, selected: [], available: [] }),
      panelHiddenUsers: async () => ({ ok: true, users: [] }),
      panelCredentialUsername: async () => ({ ok: true, username: null, setBy: null }),
    },
  };
});

async function draw(items: PanelItem[]) {
  panels.mockResolvedValue({ ok: true, items });
  render(
    <RoleProvider role="ADMIN">
      <PanelsPage onGo={() => {}} />
    </RoleProvider>,
  );
  await waitFor(() => expect(panels).toHaveBeenCalled());
}

beforeEach(() => panels.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('a panel that cannot sync says how many customers are behind it', () => {
  it('names the stranded services on the row, not just the missing password', async () => {
    await draw([panel({ hasSecretRef: false, liveSubscriptions: 2256 })]);
    await waitFor(() => expect(screen.getAllByText('تحویل نمی‌دهد').length).toBeGreaterThan(0));
    // The whole point: «رمز ندارد» alone reads as a setup step.
    expect(screen.getAllByText(/رمز ندارد — ۲٬۲۵۶ اشتراک زنده رویش هست/).length).toBeGreaterThan(0);
  });

  it('says nothing about services on a panel that has none', async () => {
    // A new panel with no password is exactly the configuration detail it looks
    // like. A count that appears for every broken panel is a count nobody reads.
    await draw([panel({ hasSecretRef: false, liveSubscriptions: 0 })]);
    await waitFor(() => expect(screen.getAllByText('تحویل نمی‌دهد').length).toBeGreaterThan(0));
    expect(screen.queryByText(/اشتراک زنده رویش هست/)).toBeNull();
  });

  it('adds the shop-wide total to the heading', async () => {
    await draw([
      panel({ id: 1, code: 'p1', hasSecretRef: false, liveSubscriptions: 2256 }),
      panel({ id: 2, code: 'p2', name: 'پنل دو', hasSecretRef: false, liveSubscriptions: 1664 }),
      panel({ id: 3, code: 'p3', name: 'پنل سه', liveSubscriptions: 134 }),
    ]);
    const head = await screen.findByText(/۳ پنل/);
    expect(within(head).queryByText).toBeDefined();
    expect(head.textContent).toContain('۲ تای‌شان سفارش تحویل نمی‌دهند');
    // 2256 + 1664, and NOT the healthy panel's 134.
    expect(head.textContent).toContain('۳٬۹۲۰ اشتراک زنده رویشان به‌روز نمی‌شود');
  });
});
