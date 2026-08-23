/**
 * A tick that reaches nobody has to say so where it is ticked.
 *
 * The panel's group ticks are a DEFAULT: they only reach a customer through a
 * service that has not chosen a level of its own. On the test panel every
 * service chooses one, so the ticks decide nothing — and an operator ticked a
 * group, pressed save, watched the bot not change, and reported it as a bug.
 * The save was correct. The screen was not: it drew a switch whose effect was
 * zero and said so only in a paragraph above the table.
 *
 * The condition is `inherit`, which the server computes from the catalogue —
 * not from the ticks — so this test cannot pass by agreeing with the code under
 * it. The two cases are the same screen with the same ticks and one different
 * fact about the shop.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { PanelGroupsSection } from '../src/pages/PanelsPage.js';
import type { PanelGroups, PanelItem } from '../src/api.js';

const panel: PanelItem = {
  id: 3,
  code: 'test-panel',
  name: 'پنل تست',
  kind: 'marzban',
  status: 'ACTIVE',
  baseUrl: 'https://example.invalid',
  capacity: null,
  sortOrder: 1,
  hasSecretRef: true,
  productCount: 3,
  planCount: 6,
  liveSubscriptions: 0,
};

/** The live panel on 2026-08-24: three groups ticked, three services, each naming its own. */
function groups(inherit: PanelGroups['inherit']): PanelGroups {
  return {
    ok: true,
    selected: [3, 6, 7],
    available: [
      { id: 3, name: 'normal' },
      { id: 6, name: 'پلاتینیوم' },
      { id: 7, name: 'طلایی' },
    ] as PanelGroups['available'],
    plans: [
      { id: 8, name: 'پلاتینیوم', level: 'PRODUCT', groups: [6] },
      { id: 9, name: 'طلایی', level: 'PRODUCT', groups: [7] },
      { id: 10, name: 'معمولی', level: 'PRODUCT', groups: [3] },
    ],
    inherit,
  };
}

const panelGroups = vi.fn<(id: number) => Promise<PanelGroups>>();
const panelInbounds = vi.fn(async (_id: number) => ({ ok: true, inbounds: [] }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      panelGroups: (id: number) => panelGroups(id),
      panelInbounds: (id: number) => panelInbounds(id),
    },
  };
});

const WARNING = /هیچ سرویس فعالی روی این پنل از پیش‌فرض استفاده نمی‌کند/;

function draw() {
  render(
    <RoleProvider role="ADMIN">
      <PanelGroupsSection panel={panel} onChanged={() => {}} onProblem={() => {}} />
    </RoleProvider>,
  );
}

describe('the panel default, when nothing reads it', () => {
  beforeEach(() => {
    panelGroups.mockReset();
    panelInbounds.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns that the ticks change nothing when no service inherits', async () => {
    panelGroups.mockResolvedValue(groups([]));
    draw();
    // The table drew — so the warning below is a statement about this screen,
    // not about a screen that failed to load.
    await waitFor(() => expect(screen.getByLabelText('پلاتینیوم')).toBeTruthy());
    expect(screen.queryByText(WARNING)).not.toBeNull();
  });

  it('says nothing when a service does ride on the default', async () => {
    panelGroups.mockResolvedValue(groups([{ id: 4, name: 'سرویس تست' }]));
    draw();
    await waitFor(() => expect(screen.getByLabelText('پلاتینیوم')).toBeTruthy());
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
