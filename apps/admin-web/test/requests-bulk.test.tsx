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
  // The third applicant has been written to (#330); the row says so.
  messagedAt: n === 3 ? Date.parse('2026-09-01T10:00:00Z') : null,
  messagedTemplate: n === 3 ? 'request_received_under_review' : null,
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

describe('writing to an applicant (#330)', () => {
  it('marks the row that was written to, and opens the texts for one that was not', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/reseller-requests/messages') && !init?.method) {
        return new Response(
          JSON.stringify({ ok: true, items: [{ key: 'k1', text: 'درخواست شما در حال بررسی است.' }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/reseller-requests/1/message') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, queued: true, template: 'k1' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    draw();
    await screen.findByText('درخواست 1');

    // Row 3 is «پیام داده شد» and green in place of «در انتظار» (#344);
    // rows 1 and 2 still wait.
    const messaged = screen.getAllByText('پیام داده شد');
    expect(messaged).toHaveLength(1);
    expect(messaged[0]!.className).toBe('badge badge-active');
    // Two rows plus the filter's option.
    expect(screen.getAllByText('در انتظار')).toHaveLength(3);

    fireEvent.click(screen.getAllByRole('button', { name: 'پیام' })[0]!);
    // In the select and in the preview under it, so two nodes carry it.
    await waitFor(() => expect(screen.getAllByText('درخواست شما در حال بررسی است.').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'ارسال از طریق ربات' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => String(u).endsWith('/reseller-requests/1/message') && i?.method === 'POST',
        ),
      ).toBe(true),
    );
    const sent = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/reseller-requests/1/message'));
    expect(JSON.parse(String(sent![1]!.body))).toEqual({ key: 'k1' });
    // Sending closes the dialogue and reloads the list.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resellerRequests.mock.calls.length).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });
});
