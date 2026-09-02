/**
 * The «ویرایش نام» action on a device card, and the dialog behind it.
 *
 * Four things are asserted that a reader of `RenameDeviceModal` cannot check
 * for themselves: the action is offered on every card and withheld from a
 * READ_ONLY operator; the dialog opens carrying the name it is about to
 * replace; a save that succeeds puts the new name on the screen without a
 * reload; and a save that fails leaves the OLD name on screen, because a UI
 * that optimistically shows a name the server refused is worse than one that
 * shows nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { DevicesView } from '../../src/hub/DevicesView.js';
import { RoleProvider } from '../../src/role.js';

const DEVICE = {
  id: 'd-1',
  device_code: 'pixel-one',
  display_name: 'Old Name',
  description: null,
  active: 1,
  last_seen_at: Date.now() - 60_000,
  last_success_at: Date.now() - 60_000,
  last_auth_failure_at: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  credential: { id: 'c-1', token_prefix: 'aaaa', last_used_at: Date.now() - 60_000 },
  last_credential_created_at: Date.now(),
};

const RETIRED = { ...DEVICE, id: 'd-2', device_code: 'pixel-two', active: 0 };

const DEVICES_PATH = '/api/v1/devices';
const PATCH_KEY = `PATCH ${DEVICES_PATH}/${DEVICE.id}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const list = (items: unknown[]) => json({ ok: true, items });

function mockFetch(routes: Record<string, Response | (() => Response)>) {
  const spy = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw);
    const method = (init?.method ?? 'GET').toUpperCase();
    const r = routes[`${method} ${url}`] ?? routes[url];
    if (!r) throw new Error(`unmocked fetch: ${method} ${url}`);
    return typeof r === 'function' ? r() : r;
  });
  globalThis.fetch = spy;
  return spy;
}

/** The card grid is the only layout now, but `useMediaQuery` still runs. */
function stubMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

const dialog = () => screen.getByRole('dialog', { name: 'ویرایش نام دستگاه' });

beforeEach(() => {
  sessionStorage.clear();
  stubMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The device card still says `name`, asked while the dialog may still be open.
 *
 * `screen.getByText` cannot answer this once the dialog is up: the name is on
 * the card AND in the dialog's «نام فعلی» line, so the query that was here
 * failed with "found multiple elements" on exactly the two tests that keep the
 * dialog open — the refusal cases, which are the ones worth asserting. Scoping
 * to the elements outside the dialog asks the question the test meant.
 */
function expectCardStillSays(name: string): void {
  const open = screen.queryByRole('dialog');
  const outside = screen
    .getAllByText(name)
    .filter((el) => open === null || !open.contains(el));
  expect(outside.length).toBeGreaterThan(0);
}

describe('the Edit-name action', () => {
  it('is offered on every device card, switched on or off', async () => {
    mockFetch({ [`GET ${DEVICES_PATH}`]: list([DEVICE, RETIRED]) });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۲)'));
    expect(screen.getAllByTestId('device-rename')).toHaveLength(2);
  });

  it('is disabled for a READ_ONLY operator, and says why', async () => {
    mockFetch({ [`GET ${DEVICES_PATH}`]: list([DEVICE]) });
    render(
      <RoleProvider role="READ_ONLY">
        <DevicesView cache={createCache()} />
      </RoleProvider>,
    );
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));
    const button = screen.getByTestId('device-rename') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('فقط-خواندنی');
  });
});

describe('the rename dialog', () => {
  it('opens pre-filled with the current name', async () => {
    mockFetch({ [`GET ${DEVICES_PATH}`]: list([DEVICE]) });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));

    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);

    const input = within(dialog()).getByTestId('rename-device-input') as HTMLInputElement;
    expect(input.value).toBe('Old Name');
    expect(within(dialog()).getByTestId('rename-device-current').textContent).toBe('Old Name');
  });

  it('refuses an empty name before asking the server', async () => {
    const fetchSpy = mockFetch({ [`GET ${DEVICES_PATH}`]: list([DEVICE]) });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));
    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);

    const input = within(dialog()).getByTestId('rename-device-input');
    fireEvent.change(input, { target: { value: '   ' } });

    const save = within(dialog()).getByTestId('rename-device-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog()).getByText('نام دستگاه نمی‌تواند خالی باشد.')).toBeTruthy();
    // No PATCH was attempted — only the initial list load happened.
    expect(fetchSpy.mock.calls.every((c) => (c[1]?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('sends only the name, then shows it on the card without a reload', async () => {
    let loads = 0;
    const fetchSpy = mockFetch({
      [`GET ${DEVICES_PATH}`]: () => {
        loads++;
        return list([loads <= 1 ? DEVICE : { ...DEVICE, display_name: 'New Name' }]);
      },
      [PATCH_KEY]: () =>
        json({
          ok: true,
          device: {
            id: DEVICE.id,
            deviceCode: DEVICE.device_code,
            displayName: 'New Name',
            description: null,
            active: true,
          },
        }),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));
    expect(screen.getByText('Old Name')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.change(within(dialog()).getByTestId('rename-device-input'), {
      target: { value: 'New Name' },
    });
    fireEvent.click(within(dialog()).getByTestId('rename-device-save'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByText('New Name')).toBeTruthy());
    expect(screen.queryByText('Old Name')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('New Name');

    const patch = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patch).toBeTruthy();
    // The request body carries the name and nothing else — no code, no key, no
    // active flag that a server bug could act on.
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
      displayName: 'New Name',
    });
  });

  it('leaves the old name on screen and explains a refusal', async () => {
    mockFetch({
      [`GET ${DEVICES_PATH}`]: () => list([DEVICE]),
      [PATCH_KEY]: () => json({ ok: false, error: 'invalid_display_name', reason: 'length' }, 400),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));

    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.change(within(dialog()).getByTestId('rename-device-input'), {
      target: { value: 'Something The Server Hates' },
    });
    fireEvent.click(within(dialog()).getByTestId('rename-device-save'));

    await waitFor(() =>
      expect(within(dialog()).getByText('نام دستگاه از ۲۰۰ نویسه بیشتر است.')).toBeTruthy(),
    );
    // The dialog is still open and the card behind it still says the old name.
    expectCardStillSays('Old Name');
    expect(
      (within(dialog()).getByTestId('rename-device-save') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says something readable when the server fails for no stated reason', async () => {
    mockFetch({
      [`GET ${DEVICES_PATH}`]: () => list([DEVICE]),
      [PATCH_KEY]: () => new Response('gateway is unwell', { status: 502 }),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));
    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.change(within(dialog()).getByTestId('rename-device-input'), {
      target: { value: 'Attempted Name' },
    });
    fireEvent.click(within(dialog()).getByTestId('rename-device-save'));

    await waitFor(() =>
      expect(within(dialog()).getByText(/ذخیرهٔ نام تازه ناموفق بود/)).toBeTruthy(),
    );
    // Dialog still open on a 502, so the name is on the card and in the dialog.
    expectCardStillSays('Old Name');
  });

  it('closes without a request when the name was not changed', async () => {
    const fetchSpy = mockFetch({ [`GET ${DEVICES_PATH}`]: () => list([DEVICE]) });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));

    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.click(within(dialog()).getByTestId('rename-device-save'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchSpy.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PATCH')).toBe(false);
    expect(screen.getByText('Old Name')).toBeTruthy();
  });

  it('cancels without writing anything', async () => {
    const fetchSpy = mockFetch({ [`GET ${DEVICES_PATH}`]: () => list([DEVICE]) });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));

    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.change(within(dialog()).getByTestId('rename-device-input'), {
      target: { value: 'Abandoned' },
    });
    fireEvent.click(within(dialog()).getByText('انصراف'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchSpy.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PATCH')).toBe(false);
    expect(screen.getByText('Old Name')).toBeTruthy();
  });

  it('keeps a Persian name with a ZWNJ intact on the way to the server', async () => {
    const persian = `گوشی\u200Cهای پویان`;
    const fetchSpy = mockFetch({
      [`GET ${DEVICES_PATH}`]: () => list([DEVICE]),
      [PATCH_KEY]: () =>
        json({
          ok: true,
          device: {
            id: DEVICE.id,
            deviceCode: DEVICE.device_code,
            displayName: persian,
            description: null,
            active: true,
          },
        }),
    });
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('دستگاه‌ها (۱)'));
    fireEvent.click(screen.getByTestId('device-rename'));
    await waitFor(dialog);
    fireEvent.change(within(dialog()).getByTestId('rename-device-input'), {
      target: { value: persian },
    });
    fireEvent.click(within(dialog()).getByTestId('rename-device-save'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const patch = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ displayName: persian });
  });
});
