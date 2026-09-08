/**
 * Deciding a queue, rather than a row.
 *
 * Staging holds 171 open requests and the screen offered two buttons per row,
 * so clearing the queue was three hundred and forty-two presses — each with
 * its own confirm dialog. The walk on 2026-09-07 called this out as the
 * difference between a screen that lists work and a screen that does it.
 *
 * Asserted on the REQUEST, not on the row disappearing: what matters is that
 * one call carries the whole selection, and that the confirmation says how
 * many people it is about before anything is sent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequestsPage } from '../src/pages/SettingsPage.js';
import { RoleProvider } from '../src/role.js';
import type { ResellerRequestRow } from '../src/api.js';

const ROWS: ResellerRequestRow[] = [1, 2, 3].map((n) => ({
  id: n,
  description: `درخواست ${n}`,
  kind: null,
  status: 'PENDING',
  createdAt: '2026-09-01T09:00:00Z',
  decidedAt: null,
  customer: { id: n, telegramId: 900_000 + n, username: `user${n}`, isReseller: false },
}));

const resellerRequests = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 3,
  page: 1,
  pageSize: 25,
  items: ROWS,
}));
const decideMany = vi.fn(async (_ids: number[], _status: string, _tier: unknown) => ({
  ok: true,
  results: ROWS.map((r) => ({ id: r.id, ok: true })),
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      resellerRequests: (p: unknown) => resellerRequests(p),
      resellerTiers: async () => ({
        ok: true,
        items: [{ code: 'n', name: 'نماینده', percent: 40, members: 2 }],
      }),
      decideResellerRequests: (ids: number[], status: string, tier: unknown) =>
        decideMany(ids, status, tier),
      decideResellerRequest: async () => ({ ok: true, status: 'APPROVED' }),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <RequestsPage />
    </RoleProvider>,
  );

afterEach(() => {
  resellerRequests.mockClear();
  decideMany.mockClear();
  vi.restoreAllMocks();
});

describe('deciding a selection of requests', () => {
  it('sends one call carrying every id that was ticked', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    draw();
    await screen.findByText('درخواست 1');

    fireEvent.click(screen.getByLabelText('انتخاب درخواست 1'));
    fireEvent.click(screen.getByLabelText('انتخاب درخواست 3'));
    fireEvent.click(screen.getByRole('button', { name: /تایید انتخاب‌شده‌ها/ }));

    await waitFor(() => expect(decideMany).toHaveBeenCalledTimes(1));
    expect(decideMany.mock.calls[0]![0]).toEqual([1, 3]);
    expect(decideMany.mock.calls[0]![1]).toBe('APPROVED');
  });

  it('says how many people it is about, and sends nothing when refused', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    draw();
    await screen.findByText('درخواست 1');

    fireEvent.click(screen.getByLabelText('انتخاب همه'));
    fireEvent.click(screen.getByRole('button', { name: /تایید انتخاب‌شده‌ها/ }));

    // The count, in the panel's digits, before anything is sent — this is the
    // widest single act on the screen.
    expect(confirm.mock.calls[0]![0]).toContain('۳');
    expect(decideMany).not.toHaveBeenCalled();
  });

  it('offers nothing to press until something is selected', async () => {
    draw();
    await screen.findByText('درخواست 1');
    expect(screen.queryByRole('button', { name: /تایید انتخاب‌شده‌ها/ })).toBeNull();
  });
});
