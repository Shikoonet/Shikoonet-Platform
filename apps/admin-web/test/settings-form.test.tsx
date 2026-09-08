/**
 * «تنظیمات» as a form, not as a dump of the settings table.
 *
 * The screen printed 163 rows of raw key and raw value — `Bot_Status`,
 * `chashbackextend`, `Lottery_Status`, ten `topic_*` rows nothing has ever
 * read — sorted by scope, every one of them editable. An operator looking for
 * «چند روز قبل از انقضا هشدار برود» read forty lines of noise to find
 * `daywarn`, and a change to any of the dead ones saved, showed no error, and
 * did nothing for ever.
 *
 * Two tabs now: the settings the shop READS, drawn as labelled controls, and
 * everything the import left behind, read-only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { RoleProvider } from '../src/role.js';

const LIVE = [
  {
    scope: 'bot',
    key: 'daywarn',
    live: true,
    label: 'هشدار انقضا (روز)',
    hint: 'چند روز مانده به انقضا به مشتری خبر داده شود.',
    kind: 'int',
    secret: false,
    value: 3,
    isSet: true,
    updatedAt: '2026-09-01T09:00:00Z',
    updatedBy: null,
  },
  {
    scope: 'bot',
    key: 'Bot_Status',
    live: true,
    label: 'ربات روشن است',
    hint: 'خاموش که باشد، ربات به هیچ پیامی جواب نمی‌دهد جز به ادمین‌ها.',
    kind: 'bool',
    secret: false,
    value: 'on',
    isSet: true,
    updatedAt: '2026-09-01T09:00:00Z',
    updatedBy: null,
  },
];

const IMPORTED = [
  {
    scope: 'bot',
    key: 'Dice',
    live: false,
    secret: false,
    value: 'on',
    isSet: true,
    updatedAt: '2026-09-01T09:00:00Z',
    updatedBy: null,
  },
  {
    scope: 'bot',
    key: 'Lottery_Status',
    live: false,
    secret: false,
    value: 'off',
    isSet: true,
    updatedAt: '2026-09-01T09:00:00Z',
    updatedBy: null,
  },
];

const settings = vi.fn(async () => ({
  ok: true,
  items: [...LIVE, ...IMPORTED],
  hiddenCount: 0,
}));
const updateSetting = vi.fn(async (_body: unknown) => ({ ok: true }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      settings: () => settings(),
      updateSetting: (body: unknown) => updateSetting(body),
      resellerRequests: async () => ({ ok: true, total: 0, page: 1, pageSize: 25, items: [] }),
      resellerTiers: async () => ({ ok: true, items: [] }),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <SettingsPage />
    </RoleProvider>,
  );

afterEach(() => {
  settings.mockClear();
  updateSetting.mockClear();
});

describe('the settings screen', () => {
  it('draws a labelled control for each setting the shop reads', async () => {
    draw();
    // The name a person uses, not the column the importer copied.
    expect(await screen.findByText('هشدار انقضا (روز)')).toBeTruthy();
    expect(screen.getByText('ربات روشن است')).toBeTruthy();
    // And the sentence that says what changing it does.
    expect(screen.getByText(/چند روز مانده به انقضا/)).toBeTruthy();
  });

  it('asks for a switch as a switch and a number as a number', async () => {
    draw();
    await screen.findByText('ربات روشن است');
    expect((screen.getByLabelText('ربات روشن است') as HTMLInputElement).type).toBe('checkbox');
    expect((screen.getByLabelText('هشدار انقضا (روز)') as HTMLInputElement).type).toBe('number');
  });

  it('keeps the imported rows out of the form and on their own tab', async () => {
    draw();
    await screen.findByText('هشدار انقضا (روز)');
    // Not in the form: a control for a key nothing reads is a promise the shop
    // cannot keep.
    expect(screen.queryByText('Dice')).toBeNull();

    //  replaces the implicit button role, so the query has to ask
    // for what the markup actually announces.
    fireEvent.click(screen.getByRole('tab', { name: /وارداتی/ }));
    // Listed, because «where did my lottery setting go» needs an answer.
    expect(await screen.findByText('Dice')).toBeTruthy();
    expect(screen.getByText('Lottery_Status')).toBeTruthy();
    // Read-only: no control at all, not a disabled one.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('saves one field on its own, with the value the control holds', async () => {
    draw();
    await screen.findByText('ربات روشن است');
    fireEvent.click(screen.getByLabelText('ربات روشن است'));

    await waitFor(() => expect(updateSetting).toHaveBeenCalledTimes(1));
    // Judged by the request body — a switch that flips on screen and sends the
    // old value is the failure this asserts against.
    expect(updateSetting.mock.calls[0]![0]).toMatchObject({
      scope: 'bot',
      key: 'Bot_Status',
      value: 'off',
    });
  });
});
