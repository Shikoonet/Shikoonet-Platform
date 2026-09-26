/**
 * «فروش به نماینده» on the panel dialog (#474).
 *
 * The table goes out in Toman exactly as typed and in the order it is on
 * screen — the server converts to IRR and prices a whole order at the tier its
 * size falls in, so a row silently re-sorted or re-scaled here would be a
 * price nobody saw. Removing every row is how the operator stops selling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { PanelsPage } from '../src/pages/PanelsPage.js';
import { ApiError, type PanelItem } from '../src/api.js';

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
  resellerSale: null,
  hasSecretRef: true,
  productCount: 0,
  planCount: 0,
  liveSubscriptions: 0,
};

let items: PanelItem[] = [A];
const panels = vi.fn(async () => ({ ok: true as const, items }));
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
  items = [A];
  panels.mockClear();
  updatePanel.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function openEditor() {
  render(
    <RoleProvider role="ADMIN">
      <PanelsPage onGo={() => {}} />
    </RoleProvider>,
  );
  await screen.findByText(items[0]!.name);
  fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
  await screen.findByRole('button', { name: /^ذخیره$/ });
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const save = () => fireEvent.click(screen.getByRole('button', { name: /^ذخیره$/ }));

describe('«فروش به نماینده»', () => {
  it('sends the tiers in screen order and the prices in Toman as typed', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'افزودن پله' }));
    fireEvent.click(screen.getByRole('button', { name: 'افزودن پله' }));
    type('از … ترابایت (پلهٔ ۱)', '1');
    type('قیمت هر ترا — تومان (پلهٔ ۱)', '3000000');
    type('از … ترابایت (پلهٔ ۲)', '3');
    type('قیمت هر ترا — تومان (پلهٔ ۲)', '2000000');
    type('شناسهٔ نقش PasarGuard', '4');
    type('سقف هر سفارش (تومان)', '50000000');
    save();

    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1));
    expect(updatePanel.mock.calls[0]?.[1]).toMatchObject({
      resellerSale: {
        tiers: [
          { fromTb: 1, pricePerTbToman: 3_000_000 },
          { fromTb: 3, pricePerTbToman: 2_000_000 },
        ],
        roleId: 4,
        // Empty is «not set», never zero.
        termDays: null,
        maxOrderToman: 50_000_000,
      },
    });
  });

  it('refuses a table that is not ascending, and sends nothing', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'افزودن پله' }));
    fireEvent.click(screen.getByRole('button', { name: 'افزودن پله' }));
    type('از … ترابایت (پلهٔ ۱)', '3');
    type('قیمت هر ترا — تومان (پلهٔ ۱)', '2000000');
    type('از … ترابایت (پلهٔ ۲)', '1');
    type('قیمت هر ترا — تومان (پلهٔ ۲)', '3000000');
    save();

    expect(await screen.findByText(/صعودی/)).toBeTruthy();
    expect(updatePanel).not.toHaveBeenCalled();
  });

  it('stops selling with null when every row is removed', async () => {
    items = [
      {
        ...A,
        resellerSale: {
          tiers: [{ fromTb: 1, pricePerTbToman: 3_000_000 }],
          roleId: 4,
          termDays: 30,
          maxOrderToman: null,
        },
      },
    ];
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'حذف پلهٔ ۱' }));
    save();

    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1));
    expect(updatePanel.mock.calls[0]?.[1]).toHaveProperty('resellerSale', null);
  });

  it('sends nothing about it when the stored table was not touched', async () => {
    items = [
      {
        ...A,
        resellerSale: {
          tiers: [{ fromTb: 1, pricePerTbToman: 3_000_000 }],
          roleId: 4,
          termDays: 30,
          maxOrderToman: null,
        },
      },
    ];
    await openEditor();
    expect((screen.getByLabelText('مهلت پنل جدید (روز)') as HTMLInputElement).value).toBe('30');
    save();

    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1));
    expect(updatePanel.mock.calls[0]?.[1]).not.toHaveProperty('resellerSale');
  });

  it('shows the server’s Persian sentence when it refuses the table', async () => {
    updatePanel.mockRejectedValueOnce(
      new ApiError(400, 'invalid_body', 'کمترین سفارش از سقف هر سفارش بیشتر است.'),
    );
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'افزودن پله' }));
    type('از … ترابایت (پلهٔ ۱)', '2');
    type('قیمت هر ترا — تومان (پلهٔ ۱)', '3000000');
    save();

    expect(await screen.findByText('کمترین سفارش از سقف هر سفارش بیشتر است.')).toBeTruthy();
  });

  it('is not offered on a panel that is not PasarGuard', async () => {
    items = [{ ...A, kind: 'hiddify', name: 'پنل هیدیفای' }];
    await openEditor();
    expect(screen.queryByText('🏢 فروش به نماینده')).toBeNull();
  });
});
