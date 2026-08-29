/**
 * The way out of a dead end.
 *
 * A device that has relayed even one bank SMS cannot be deleted — the server
 * refuses, correctly, because `raw_sms_events` is `ON DELETE RESTRICT` and the
 * transaction candidates built from those events cascade off them. This modal
 * used to state that and stop, which meant seven of the eight devices on
 * staging on 2026-08-29 were permanently unremovable.
 *
 * Now it offers the only safe route: move the history to another device, then
 * delete. These tests pin the three things that make that route trustworthy —
 * it names a target, it says what will move, and it refuses when the ingest's
 * per-device de-duplication index would swallow a message on arrival.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteDeviceModal } from '../../src/hub/DeleteDeviceModal.js';

const SOURCE = {
  id: 'd-old',
  device_code: 'phone-old',
  display_name: 'گوشی قدیمی',
  description: null,
  active: 0,
  last_seen_at: null,
  last_success_at: null,
  last_auth_failure_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  credential: null,
  last_credential_created_at: null,
};

const TARGET = { ...SOURCE, id: 'd-new', device_code: 'phone-new', display_name: 'گوشی تازه', active: 1 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BLOCKED_PREVIEW = {
  ok: true,
  device: { id: 'd-old', deviceCode: 'phone-old', displayName: 'گوشی قدیمی', active: false },
  references: { rawSmsEvents: 103, financialAccounts: 7, credentials: 1, transactions: 85 },
  canDelete: false,
  blockingReasons: ['device_in_use'],
};

function movePreview(over: Partial<{ duplicateSmsOnTarget: number; canMove: boolean }> = {}) {
  return {
    ok: true,
    source: { id: 'd-old', deviceCode: 'phone-old', displayName: 'گوشی قدیمی' },
    target: { id: 'd-new', deviceCode: 'phone-new', displayName: 'گوشی تازه' },
    moves: { rawSmsEvents: 103, financialAccounts: 7, transactions: 85 },
    duplicateSmsOnTarget: 0,
    canMove: true,
    canDeleteSourceAfterwards: true,
    ...over,
  };
}

/** Records every request so an assertion can be made about the call, not the screen. */
function mockFetch(routes: Record<string, () => Response>, seen: Array<[string, string, unknown]>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname + new URL(raw).search : raw;
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push([method, url, init?.body ? JSON.parse(String(init.body)) : null]);
    const key = `${method} ${url.split('?')[0]}`;
    const r = routes[key];
    if (!r) throw new Error(`unmocked fetch: ${method} ${url}`);
    return r();
  });
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('deleting a device that carries history', () => {
  it('offers a target, says what moves, and sends one move-and-delete request', async () => {
    const seen: Array<[string, string, unknown]> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          'GET /api/v1/devices/d-old/delete-preview': () => json(BLOCKED_PREVIEW),
          'GET /api/v1/devices/d-old/move-preview': () => json(movePreview()),
          'POST /api/v1/devices/d-old/move-references': () =>
            json({
              ok: true,
              moved: { rawSmsEvents: 103, financialAccounts: 7, transactions: 85 },
              target: { id: 'd-new', deviceCode: 'phone-new' },
              deletedSource: true,
            }),
        },
        seen,
      ),
    );
    const onDeleted = vi.fn();
    render(
      <DeleteDeviceModal
        device={SOURCE}
        devices={[SOURCE, TARGET]}
        onClose={() => undefined}
        onDeleted={onDeleted}
      />,
    );

    const picker = (await screen.findByTestId('device-move-target')) as HTMLSelectElement;
    // The source is never a target for its own history.
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'd-new']);

    fireEvent.change(picker, { target: { value: 'd-new' } });
    await screen.findByTestId('device-move-summary');

    const button = screen.getByRole('button', { name: 'انتقال سابقه و حذف همیشگی' });
    // Still gated on typing the name: picking a target is not consent.
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'phone-old' } });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('d-old'));
    // Asserted on the request. One call, carrying the target and the delete —
    // not a move followed by a separate delete that could half-happen.
    const posts = seen.filter(([m]) => m === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]).toBe('/api/v1/devices/d-old/move-references');
    expect(posts[0]![2]).toEqual({ targetDeviceId: 'd-new', deleteSource: true });
  });

  it('refuses when the target already holds the same messages, and sends nothing', async () => {
    const seen: Array<[string, string, unknown]> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          'GET /api/v1/devices/d-old/delete-preview': () => json(BLOCKED_PREVIEW),
          'GET /api/v1/devices/d-old/move-preview': () =>
            json(movePreview({ duplicateSmsOnTarget: 12, canMove: false })),
        },
        seen,
      ),
    );
    render(
      <DeleteDeviceModal
        device={SOURCE}
        devices={[SOURCE, TARGET]}
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    fireEvent.change(await screen.findByTestId('device-move-target'), {
      target: { value: 'd-new' },
    });
    await screen.findByTestId('device-move-conflict');

    // No confirmation field at all: there is nothing to confirm yet, and
    // offering one would let an operator type the name and press a button that
    // could only fail.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(seen.filter(([m]) => m === 'POST')).toHaveLength(0);
  });

  it('sends nobody to a merge when the device is merely still switched on', async () => {
    const seen: Array<[string, string, unknown]> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          'GET /api/v1/devices/d-old/delete-preview': () =>
            json({
              ...BLOCKED_PREVIEW,
              device: { ...BLOCKED_PREVIEW.device, active: true },
              blockingReasons: ['device_must_be_inactive', 'device_in_use'],
            }),
        },
        seen,
      ),
    );
    render(
      <DeleteDeviceModal
        device={{ ...SOURCE, active: 1 }}
        devices={[SOURCE, TARGET]}
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    await screen.findByText(/دستگاه هنوز روشن است/);
    // The picker would suggest a merge fixes this. It does not — the switch does.
    expect(screen.queryByTestId('device-move')).toBeNull();
  });

  it('deletes outright when there is no history, without offering a merge', async () => {
    const seen: Array<[string, string, unknown]> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          'GET /api/v1/devices/d-old/delete-preview': () =>
            json({
              ...BLOCKED_PREVIEW,
              references: { rawSmsEvents: 0, financialAccounts: 0, credentials: 1, transactions: 0 },
              canDelete: true,
              blockingReasons: [],
            }),
          'DELETE /api/v1/devices/d-old': () =>
            json({ ok: true, deleted: 'd-old', deletedCredentialCount: 1 }),
        },
        seen,
      ),
    );
    const onDeleted = vi.fn();
    render(
      <DeleteDeviceModal
        device={SOURCE}
        devices={[SOURCE, TARGET]}
        onClose={() => undefined}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'phone-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'حذف همیشگی' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('d-old'));
    expect(screen.queryByTestId('device-move')).toBeNull();
    expect(seen.some(([m]) => m === 'DELETE')).toBe(true);
  });
});
