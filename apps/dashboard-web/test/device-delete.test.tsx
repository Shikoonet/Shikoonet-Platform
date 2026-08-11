/**
 * DevicesView permanent-delete modal — contract tests.
 *
 * Verifies:
 *   - The Delete permanently button ONLY appears on inactive rows
 *     (desktop + mobile card paths).
 *   - Clicking it mounts DeleteDeviceModal which fetches delete-preview.
 *   - The destructive Confirm button stays disabled until the user types
 *     either the display name OR the device code exactly.
 *   - After successful delete: modal closes, success banner shown, devices
 *     list is invalidated and the device is gone from the UI.
 *   - Polling the devices list while the modal is open does NOT re-open
 *     the modal or wipe the typed input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../src/query.js';
import { DevicesView } from '../src/DevicesView.js';

const ACTIVE_DEVICE = {
  id: 'd-active',
  device_code: 'pixel-active',
  display_name: 'Pixel Active',
  description: null,
  active: 1,
  last_seen_at: Date.now() - 60_000,
  last_success_at: Date.now() - 60_000,
  last_auth_failure_at: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  credential: {
    id: 'c-active',
    token_prefix: 'aaaa',
    last_used_at: Date.now() - 60_000,
  },
  last_credential_created_at: Date.now(),
};

const INACTIVE_DEVICE = {
  ...ACTIVE_DEVICE,
  id: 'd-inactive',
  device_code: 'pixel-inactive',
  display_name: 'Pixel Inactive',
  active: 0,
};

const DEVICES_PATH = '/api/v1/devices';

function devicesListResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deletePreviewResponse(device: typeof INACTIVE_DEVICE): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      device: {
        id: device.id,
        deviceCode: device.device_code,
        displayName: device.display_name,
        active: false,
      },
      references: {
        rawSmsEvents: 0,
        financialAccounts: 0,
        credentials: 1,
        transactions: 0,
      },
      canDelete: true,
      blockingReasons: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function deleteDeviceResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      deleted: id,
      references: {
        rawSmsEvents: 0,
        financialAccounts: 0,
        credentials: 1,
        transactions: 0,
      },
      deletedCredentialCount: 1,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetch(routes: Record<string, Response | (() => Response)>): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url}`;
    let r = routes[key];
    if (!r) r = routes[url];
    if (!r) throw new Error(`unmocked fetch: ${method} ${url}`);
    return typeof r === 'function' ? r() : r;
  });
}

function wideMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: !q.includes('max-width: 639'),
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function mobileMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('max-width: 639'),
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DevicesView Delete permanently — desktop path', () => {
  it('renders Delete permanently only on inactive rows', async () => {
    wideMatchMedia();
    globalThis.fetch = mockFetch({
      [`GET ${DEVICES_PATH}`]: devicesListResponse([ACTIVE_DEVICE, INACTIVE_DEVICE]),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Devices (2)'));
    // There should be exactly one Delete permanently button — for the inactive row.
    const buttons = screen.getAllByTestId('device-delete');
    expect(buttons.length).toBe(1);
    expect(buttons[0]).toBeTruthy();
  });

  it('opens the modal, requires typed confirmation, and disables the Confirm button until typed', async () => {
    wideMatchMedia();
    const deviceId = INACTIVE_DEVICE.id;
    globalThis.fetch = mockFetch({
      [`GET ${DEVICES_PATH}`]: devicesListResponse([INACTIVE_DEVICE]),
      [`GET ${DEVICES_PATH}/${encodeURIComponent(deviceId)}/delete-preview`]: () =>
        deletePreviewResponse(INACTIVE_DEVICE),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Devices (1)'));

    fireEvent.click(screen.getByTestId('device-delete'));

    await waitFor(() => screen.getByRole('dialog', { name: 'Delete device permanently' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete device permanently' });
    const confirm = dialog.querySelector('button.danger') as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    // Disabled while input is empty.
    expect(confirm.disabled).toBe(true);

    // Wrong text → still disabled.
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(confirm.disabled).toBe(true);

    // Type display name → enabled.
    fireEvent.change(input, { target: { value: INACTIVE_DEVICE.display_name } });
    expect(confirm.disabled).toBe(false);

    // Replace with device code → also enabled.
    fireEvent.change(input, { target: { value: INACTIVE_DEVICE.device_code } });
    expect(confirm.disabled).toBe(false);
  });

  it('completes the delete, closes the modal, shows success banner, and removes the row', async () => {
    wideMatchMedia();
    const deviceId = INACTIVE_DEVICE.id;
    let listCallCount = 0;
    globalThis.fetch = mockFetch({
      [`GET ${DEVICES_PATH}`]: () => {
        listCallCount++;
        // After delete: list returns empty.
        return devicesListResponse(listCallCount <= 1 ? [INACTIVE_DEVICE] : []);
      },
      [`GET ${DEVICES_PATH}/${encodeURIComponent(deviceId)}/delete-preview`]: () =>
        deletePreviewResponse(INACTIVE_DEVICE),
      [`DELETE ${DEVICES_PATH}/${encodeURIComponent(deviceId)}`]: () =>
        deleteDeviceResponse(deviceId),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Devices (1)'));

    fireEvent.click(screen.getByTestId('device-delete'));
    await waitFor(() => screen.getByRole('dialog', { name: 'Delete device permanently' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete device permanently' });
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: INACTIVE_DEVICE.display_name } });
    fireEvent.click(dialog.querySelector('button.danger') as HTMLButtonElement);

    // Modal closes.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete device permanently' })).toBeNull();
    });
    // Success banner shown.
    expect(screen.getByRole('status').textContent).toMatch(/Pixel Inactive deleted/);
    // Row removed.
    await waitFor(() => screen.getByText('Devices (0)'));
    expect(screen.queryByText('Pixel Inactive')).toBeNull();
  });
});

describe('DevicesView Delete permanently — mobile path', () => {
  it('renders Delete permanently on the mobile inactive card', async () => {
    mobileMatchMedia();
    globalThis.fetch = mockFetch({
      [`GET ${DEVICES_PATH}`]: devicesListResponse([ACTIVE_DEVICE, INACTIVE_DEVICE]),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Devices (2)'));
    expect(screen.getAllByTestId('device-delete').length).toBe(1);
  });
});

describe('DevicesView Delete permanently — regression: polling does not reopen modal', () => {
  it('keeps the modal mounted while a background refetch happens', async () => {
    wideMatchMedia();
    const deviceId = INACTIVE_DEVICE.id;
    globalThis.fetch = mockFetch({
      [`GET ${DEVICES_PATH}`]: devicesListResponse([INACTIVE_DEVICE]),
      [`GET ${DEVICES_PATH}/${encodeURIComponent(deviceId)}/delete-preview`]: () =>
        deletePreviewResponse(INACTIVE_DEVICE),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Devices (1)'));

    fireEvent.click(screen.getByTestId('device-delete'));
    await waitFor(() => screen.getByRole('dialog', { name: 'Delete device permanently' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete device permanently' });
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: INACTIVE_DEVICE.display_name } });

    // Simulate a background refetch by waiting a tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Modal still mounted, typed input preserved.
    const dialogAfter = screen.getByRole('dialog', { name: 'Delete device permanently' });
    expect(dialogAfter).toBeTruthy();
    expect((dialogAfter.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(
      INACTIVE_DEVICE.display_name,
    );
  });
});
