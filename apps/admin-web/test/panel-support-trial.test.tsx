/**
 * «تست از پشتیبانی» and the sample link on the panel dialog.
 *
 * The support bot orders a trial through the ingest server's door only on a
 * panel whose switch is on, and lists servers from the sample link. Both are
 * sent with the trial numbers, because the route refuses the switch without
 * them — the same shape the shop trial's trio already has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { PanelsPage } from '../src/pages/PanelsPage.js';
import type { PanelItem } from '../src/api.js';

const A: PanelItem = {
  id: 1,
  code: 'alpha',
  name: 'پنل آلفا',
  kind: 'pasarguard',
  status: 'ACTIVE',
  baseUrl: 'https://alpha.example:9443',
  capacity: null,
  sortOrder: 1,
  renewMode: 'RESET',
  extraVolumeMinGb: null,
  extraTimeMinDays: null,
  newcomersOnly: false,
  dashboardPath: null,
  renewEnabled: true,
  usernameMode: 'TELEGRAM_ID',
  usernameText: null,
  trial: { enabled: false, volumeGb: null, durationHours: null },
  supportTrial: { enabled: false, volumeGb: null, durationHours: null },
  supportSampleSubscriptionUrl: null,
  extraVolumeTomanPerGb: { f: null, n: null, n2: null },
  extraTimeTomanPerDay: { f: null, n: null, n2: null },
  downgradeGroupIds: [],
  hasSecretRef: true,
  productCount: 0,
  planCount: 0,
  liveSubscriptions: 0,
};

const panels = vi.fn(async () => ({ ok: true as const, items: [A] }));
const updatePanel = vi.fn(async (_id: number, _patch: Record<string, unknown>) => ({
  ok: true as const,
  panel: A,
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      panels: () => panels(),
      updatePanel: (id: number, patch: Record<string, unknown>) => updatePanel(id, patch),
      panelGroups: async () => ({ ok: true, selected: [], available: [] }),
      panelHiddenUsers: async () => ({ ok: true, users: [] }),
      panelCredentialUsername: async () => ({ ok: true, username: null, setBy: null }),
    },
  };
});

beforeEach(() => {
  panels.mockClear();
  updatePanel.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('«تست از پشتیبانی» on the panel dialog', () => {
  it('sends the switch and the sample link with the trial numbers', async () => {
    render(
      <RoleProvider role="ADMIN">
        <PanelsPage onGo={() => {}} />
      </RoleProvider>,
    );
    await screen.findByText('پنل آلفا');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));

    fireEvent.click(await screen.findByLabelText('تست از پشتیبانی'));
    fireEvent.change(screen.getByLabelText('لینک اکانت نمونه برای فهرست سرورها'), {
      target: { value: 'https://sub.example/sample' },
    });
    fireEvent.change(screen.getByLabelText('حجم (گیگابایت)'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('مدت (ساعت)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /^ذخیره$/ }));

    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1));
    expect(updatePanel.mock.calls[0]?.[1]).toMatchObject({
      supportTrialEnabled: true,
      supportSampleSubscriptionUrl: 'https://sub.example/sample',
      trialVolumeGb: 0.2,
      trialDurationHours: 2,
    });
  });

  it('sends nothing about the support door when it was not touched', async () => {
    render(
      <RoleProvider role="ADMIN">
        <PanelsPage onGo={() => {}} />
      </RoleProvider>,
    );
    await screen.findByText('پنل آلفا');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    fireEvent.click(await screen.findByRole('button', { name: /^ذخیره$/ }));

    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1));
    expect(updatePanel.mock.calls[0]?.[1]).not.toHaveProperty('supportTrialEnabled');
    expect(updatePanel.mock.calls[0]?.[1]).not.toHaveProperty('supportSampleSubscriptionUrl');
  });
});
