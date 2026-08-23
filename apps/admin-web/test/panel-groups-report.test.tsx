/**
 * The panel's groups tab is a report, and the proof is what it does NOT offer.
 *
 * This replaces `panel-default-inert.test.tsx`, which asserted a warning above
 * a tick column that could not affect anything. The warning was the right
 * diagnosis and the wrong cure: an operator had ticked that column three times,
 * saved, and watched the bot not change, because the ticks are a fallback that
 * only reaches a customer through a service which has chosen no level of its
 * own — and every service on that panel had chosen one. Apologising beside a
 * dead control is worse than removing it.
 *
 * So the assertions are: no tick, no save, no group editing — those all moved
 * to «سرویس‌ها» beside the service that sells the group — and the one thing
 * only this screen can say is still said.
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

/** The live test panel on 2026-08-24, plus one id the panel does not have. */
function groups(over: Partial<PanelGroups> = {}): PanelGroups {
  return {
    ok: true,
    selected: [3, 6, 7],
    available: [
      { id: 3, name: 'normal' },
      { id: 6, name: 'پلاتینیوم' },
      { id: 7, name: 'طلایی' },
    ] as PanelGroups['available'],
    plans: [{ id: 10, name: 'معمولی', level: 'PRODUCT', groups: [3] }],
    inherit: [],
    ...over,
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

function draw() {
  render(
    <RoleProvider role="ADMIN">
      <PanelGroupsSection panel={panel} onProblem={() => {}} />
    </RoleProvider>,
  );
}

describe('the panel groups tab', () => {
  beforeEach(() => {
    panelGroups.mockReset();
    panelInbounds.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports what the panel has, and offers no way to change it', async () => {
    panelGroups.mockResolvedValue(groups());
    draw();
    await waitFor(() => expect(screen.getByText('پلاتینیوم')).toBeTruthy());

    // The report is here…
    expect(screen.getByText('طلایی')).toBeTruthy();
    expect(screen.getByText('سرویس معمولی')).toBeTruthy();

    // …and every control that used to sit beside it is not. A tick with no
    // effect is what sent an operator round this loop three times.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /ذخیره/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /گروه تازه/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ویرایش' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حذف' })).toBeNull();
  });

  it('still raises the one alarm only this screen can raise', async () => {
    // A group id in our config that the panel does not have. PasarGuard answers
    // a create with 404 and the adapter calls that non-retryable, so every
    // order on that level goes FAILED and refunds. Nothing else in the panel
    // notices — the catalogue screen shows it per service, this shows it for
    // the panel's own default.
    panelGroups.mockResolvedValue(groups({ selected: [3, 42] }));
    draw();
    await waitFor(() => expect(screen.getByText(/روی خودِ پنل وجود ندارد/)).toBeTruthy());
    expect(screen.getByText('روی پنل نیست')).toBeTruthy();
  });

  it('says where the editing went', async () => {
    // An operator who used to make a group here has to be told once where it
    // moved, or the removal reads as a lost feature.
    panelGroups.mockResolvedValue(groups());
    draw();
    await waitFor(() => expect(screen.getByText(/«سرویس‌ها»/)).toBeTruthy());
  });
});
