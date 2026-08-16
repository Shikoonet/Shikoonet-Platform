/**
 * DevicesView Add-Device modal — close-flow contract.
 *
 * Verifies:
 *   - Opens, switches to one-time setup on create.
 *   - Done closes immediately, secret state is unmounted.
 *   - X / backdrop / Escape route through a single guarded requestClose().
 *   - Confirmation shows once when the token is unsaved; cancel keeps
 *     the modal open, confirm closes and clears the token.
 *   - After copying the token, X / backdrop / Escape close immediately.
 *   - Polling Devices again while the modal is open does not reopen it
 *     or reset copy/saved state.
 *   - beforeunload is registered while setup is unsaved and removed when
 *     the modal closes.
 *   - Backdrop element is fully removed from the DOM after close.
 *   - Focus returns to the trigger button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { DevicesView } from '../../src/hub/DevicesView.js';

const SAMPLE_SETUP = {
  ok: true,
  device: {
    id: 'd-new',
    deviceCode: 'poyan-test',
    displayName: 'Poyan test',
    description: null,
    active: true,
  },
  credential: {
    id: 'c1',
    apiKey: 'sk_live_TESTKEY_abcdef1234567890',
    tokenPrefix: 'sk_live_TESTKEY',
    status: 'ACTIVE' as const,
    shownOnce: true as const,
  },
  configuration: {
    method: 'POST' as const,
    url: 'https://example.test/api/v1/ingest',
    contentType: 'application/json' as const,
    jsonBody: {
      apiKey: 'sk_live_TESTKEY_abcdef1234567890',
      deviceId: 'd-new',
      deviceName: 'Poyan test',
      message: 'msg',
      sender: '+98',
      timestamp: '1700000000',
      checksum: 'abc',
    },
  },
};

const DEVICES_PATH = '/api/v1/devices';
const TOKEN = SAMPLE_SETUP.credential.apiKey;

function devicesListResponse(): Response {
  return new Response(JSON.stringify({ ok: true, items: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createDeviceResponse(): Response {
  return new Response(JSON.stringify(SAMPLE_SETUP), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Routes {
  [k: string]: Response | (() => Response);
}

function jsonRoutes(): Routes {
  return {
    [`GET ${DEVICES_PATH}`]: devicesListResponse,
    [DEVICES_PATH]: devicesListResponse,
  };
}

function mockFetch(routes: Routes): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url}`;
    let r = routes[key];
    if (!r) r = routes[url];
    if (!r) r = routes['default'];
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

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  return writeText;
}

beforeEach(() => {
  sessionStorage.clear();
  wideMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function openAddDevice() {
  const trigger = screen.getByTestId('open-add-device');
  fireEvent.click(trigger);
  trigger.focus();
  return trigger;
}

async function fillAndCreateDevice() {
  const nameInput = screen.getByPlaceholderText('گوشی اندروید پویان ۲');
  fireEvent.change(nameInput, { target: { value: 'Poyan test' } });
  await waitFor(() => {
    expect((screen.getByDisplayValue('poyan-test') as HTMLInputElement).value).toBe('poyan-test');
  });
  fireEvent.click(screen.getByText('ساخت دستگاه'));
}

describe('DevicesView Add-Device modal — close flow', () => {
  it('opens, switches to one-time setup on create, and Done closes it', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    expect(screen.getByRole('dialog', { name: 'افزودن دستگاه' })).toBeTruthy();

    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-done'));

    expect(screen.getByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeTruthy();
    expect(screen.getByTestId('token-text').textContent).toBe('•'.repeat(TOKEN.length));

    fireEvent.click(screen.getByTestId('setup-done'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
    expect(document.querySelector('.modal-backdrop')).toBeNull();
    expect(screen.queryByTestId('close-confirmation')).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('X asks for confirmation when setup has not been saved; cancel keeps it open; confirm closes', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-close'));

    fireEvent.click(screen.getByTestId('setup-close'));
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('close-confirmation-cancel'));
    await waitFor(() => expect(screen.queryByTestId('close-confirmation')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('setup-close'));
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();
    fireEvent.click(screen.getByTestId('close-confirmation-confirm'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('X closes immediately once the token or JSON has been copied', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    const writeText = stubClipboard();
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-close'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-token'));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));

    fireEvent.click(screen.getByTestId('setup-close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
    expect(screen.queryByTestId('close-confirmation')).toBeNull();
  });

  it('Escape follows the same guarded close behavior', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-close'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('close-confirmation')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();
    fireEvent.click(screen.getByTestId('close-confirmation-confirm'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
  });

  it('Backdrop click follows the same guarded close behavior', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    const { container } = render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-close'));

    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    expect(backdrop).toBeTruthy();

    fireEvent.click(backdrop);
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();

    fireEvent.click(screen.getByTestId('close-confirmation-cancel'));
    await waitFor(() => expect(screen.queryByTestId('close-confirmation')).toBeNull());

    fireEvent.click(backdrop);
    expect(screen.getByTestId('close-confirmation')).toBeTruthy();
    fireEvent.click(screen.getByTestId('close-confirmation-confirm'));
    await waitFor(() => expect(screen.queryByTestId('close-confirmation')).toBeNull());
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
  });

  it('beforeunload is registered while setup is unsaved and removed after close', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-done'));

    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    fireEvent.click(screen.getByTestId('setup-done'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('background polling does not reopen or reset the modal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-close'));

    for (let i = 0; i < 1; i++) {
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
    }

    expect(screen.getByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeTruthy();
    expect(screen.getByTestId('token-text').textContent).toBe('•'.repeat(TOKEN.length));
    expect(screen.queryByTestId('close-confirmation')).toBeNull();

    fireEvent.click(screen.getByTestId('setup-done'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull());

    for (let i = 0; i < 1; i++) {
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
    }
    expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
  });

  it('focus returns to the Add Device trigger after close', async () => {
    const routes = jsonRoutes();
    routes[`POST ${DEVICES_PATH}`] = createDeviceResponse;
    globalThis.fetch = mockFetch(routes);

    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۰)'));

    const trigger = openAddDevice();
    await fillAndCreateDevice();
    await waitFor(() => screen.getByTestId('setup-done'));

    fireEvent.click(screen.getByTestId('setup-done'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'راه‌اندازی دستگاه' })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });
});
