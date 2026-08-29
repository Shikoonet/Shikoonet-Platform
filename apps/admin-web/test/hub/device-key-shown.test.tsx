/**
 * A minted key must reach the screen.
 *
 * `POST /devices/:id/credentials` and `.../credentials/rotate` both answer with
 * `credential.apiKey` — the plaintext, returned exactly once, never recoverable
 * — plus the ready-to-paste `configuration`. `DevicesView` awaited both, threw
 * the response away, and invalidated the list.
 *
 * So pressing «ساخت کلید» wrote a credential hash to the database and destroyed
 * the only copy of the key that phone needed. The row grew a token prefix and
 * nothing said what had happened. Rotating to recover destroyed the next one
 * the same way. On staging on 2026-08-29 all eight devices sat on «نیازمند
 * توکن» beside a button whose only effect was to make the device permanently
 * unusable.
 *
 * These tests fail if that response is ever dropped again. Delete the
 * `setSetup(...)` line in `mintKey` and the first two go red: the modal never
 * mounts and no key is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { DevicesView } from '../../src/hub/DevicesView.js';

const KEY = 'sk_live_ONETIME_0123456789abcdef';

const NO_KEY_DEVICE = {
  id: 'd-fresh',
  device_code: 'phone-fresh',
  display_name: 'گوشی تازه',
  description: null,
  active: 1,
  last_seen_at: null,
  last_success_at: null,
  last_auth_failure_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  credential: null,
  last_credential_created_at: null,
};

const KEYED_DEVICE = {
  ...NO_KEY_DEVICE,
  id: 'd-keyed',
  device_code: 'phone-keyed',
  display_name: 'گوشی کارکرده',
  last_seen_at: 1_700_000_000_000,
  last_success_at: 1_700_000_000_000,
  credential: { id: 'c-1', token_prefix: 'sk_live_', last_used_at: 1_700_000_000_000 },
};

function setupPayload(device: { id: string; device_code: string; display_name: string }) {
  return {
    ok: true,
    device: {
      id: device.id,
      deviceCode: device.device_code,
      displayName: device.display_name,
      description: null,
      active: true,
    },
    credential: {
      id: 'c-new',
      apiKey: KEY,
      tokenPrefix: 'sk_live_',
      status: 'ACTIVE',
      shownOnce: true,
    },
    configuration: {
      method: 'POST',
      url: 'https://shikoo.example/api/v1/sms',
      contentType: 'application/json',
      jsonBody: {
        apiKey: KEY,
        deviceId: device.device_code,
        deviceName: device.display_name,
        message: '{sms_body}',
        sender: '{sms_sender}',
        timestamp: '{sms_timestamp}',
        checksum: '{sms_checksum}',
      },
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routed by `METHOD path`, so a POST to credentials cannot be served the list. */
function mockFetch(routes: Record<string, () => Response>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw);
    const method = (init?.method ?? 'GET').toUpperCase();
    const r = routes[`${method} ${url}`] ?? routes[url];
    if (!r) throw new Error(`unmocked fetch: ${method} ${url}`);
    return r();
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

beforeEach(() => {
  sessionStorage.clear();
  wideMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a key that is minted is shown', () => {
  it('«ساخت کلید» puts the returned key on screen instead of discarding it', async () => {
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [NO_KEY_DEVICE] }),
      'POST /api/v1/devices/d-fresh/credentials': () => json(setupPayload(NO_KEY_DEVICE)),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DevicesView cache={createCache()} />);
    const button = await screen.findByRole('button', { name: 'ساخت کلید' });

    // Before the press the key exists nowhere — the premise of the whole test.
    expect(document.body.textContent).not.toContain(KEY);

    fireEvent.click(button);

    // The modal mounts because the response was kept, not because the list
    // changed: the list mock still answers with the same credential-less row.
    const token = await screen.findByTestId('token-text');
    // Masked until asked for, and revealed on request — but present either way,
    // which is what "not discarded" means.
    fireEvent.click(screen.getByRole('button', { name: 'نمایش' }));
    await waitFor(() => expect(token.textContent).toBe(KEY));

    expect(screen.getByTestId('copy-token')).toBeTruthy();
    expect(screen.getByText('کلید ساخته شد — همین حالا بردار')).toBeTruthy();
  });

  it('«چرخش کلید» shows the replacement, and says the old one is already dead', async () => {
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [KEYED_DEVICE] }),
      'POST /api/v1/devices/d-keyed/credentials/rotate': () => json(setupPayload(KEYED_DEVICE)),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<DevicesView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'چرخش کلید' }));

    await screen.findByTestId('token-text');
    expect(screen.getByText('کلید عوض شد — همین حالا بردار')).toBeTruthy();
    // The sentence an operator acts on: the phone is already offline.
    expect(screen.getByText(/کلید قبلی همین الان از کار افتاد/)).toBeTruthy();
  });

  it('declining the rotate question mints nothing at all', async () => {
    const rotate = vi.fn(() => json(setupPayload(KEYED_DEVICE)));
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [KEYED_DEVICE] }),
      'POST /api/v1/devices/d-keyed/credentials/rotate': rotate,
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<DevicesView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'چرخش کلید' }));

    // Asserted against the request, not the screen. A dialog that cancels the
    // modal but still spends the credential would look identical here.
    await waitFor(() => expect(rotate).not.toHaveBeenCalled());
    expect(screen.queryByTestId('token-text')).toBeNull();
  });

  it('a device with no key says why, and one that works says nothing', async () => {
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [NO_KEY_DEVICE, KEYED_DEVICE] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DevicesView cache={createCache()} />);
    await screen.findByText('گوشی تازه');

    // The line that answers «معلوم نیست دکمه‌ها چیکار می‌کنن» for this row.
    expect(screen.getByText(/هنوز کلیدی ندارد/)).toBeTruthy();
    // And a healthy device gets no advice — noise on every row teaches the
    // operator to stop reading the one row that matters.
    expect(screen.queryByText(/هیچ‌وقت وصل نشده/)).toBeNull();
  });
});

describe('switched-off devices leave the working area', () => {
  it('puts them behind a collapsed section rather than among the live ones', async () => {
    const off = { ...KEYED_DEVICE, id: 'd-off', device_code: 'phone-off', active: 0 };
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [NO_KEY_DEVICE, off] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DevicesView cache={createCache()} />);
    await screen.findByText('گوشی تازه');

    const live = screen.getByLabelText('دستگاه‌های روشن');
    const retired = screen.getByTestId('retired-devices');
    expect(live.textContent).toContain('phone-fresh');
    expect(live.textContent).not.toContain('phone-off');
    expect(retired.textContent).toContain('phone-off');
    // Collapsed: eight retired phones must not push the live one off the screen.
    expect((retired as HTMLDetailsElement).open).toBe(false);
  });
});

describe('a refusal an operator cannot act on', () => {
  it('says what INGEST_URL is and where it belongs, instead of printing the code', async () => {
    const fetchMock = mockFetch({
      'GET /api/v1/devices': () => json({ ok: true, items: [NO_KEY_DEVICE] }),
      'POST /api/v1/devices/d-fresh/credentials': () =>
        new Response(
          JSON.stringify({ ok: false, error: 'ingest_url_not_configured' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DevicesView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'ساخت کلید' }));

    // The sentence names the variable and says the fix is not on this screen.
    // Without it the operator reads `Error: 503: ingest_url_not_configured`,
    // which is the fault and not one thing to do about it.
    await screen.findByText(/INGEST_URL/);
    expect(screen.getByText(/سمت دیپلوی است/)).toBeTruthy();
    // And no key modal, because no key was issued.
    expect(screen.queryByTestId('token-text')).toBeNull();
  });
});
