/**
 * The edit dialog belongs to ONE panel, and opening it again means a new one.
 *
 * `<PanelModal panel={editing}>` was mounted without a `key`, so React kept the
 * same component instance when `editing` changed from panel A to panel B. Every
 * field is seeded by `useState(panel?.name ?? '')`, and a `useState`
 * initialiser runs once per mount — so the form went on showing A's values
 * while saving against B's id. «ذخیره» then wrote A's name and renew mode onto
 * panel B and answered «ذخیره شد.». Sam did this by accident on staging and
 * undid it from `audit_logs`.
 *
 * The obvious repair is `key={editing?.id ?? 'new'}`, and the second test here
 * is why it is the wrong one: creating a panel deliberately turns this same
 * dialog into the EDITOR for the panel just made, so that key changes from
 * `'new'` to an id in the middle of one flow and remounts — throwing away the
 * status note that says whether the new panel came up ACTIVE, which is the
 * whole reason the dialog stays open. The key is therefore per OPENING, not per
 * panel id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { PanelsPage } from '../src/pages/PanelsPage.js';
import type { PanelItem } from '../src/api.js';

function panel(id: number, code: string, name: string): PanelItem {
  return {
    id,
    code,
    name,
    kind: 'pasarguard',
    status: 'ACTIVE',
    baseUrl: `https://${code}.example:9443`,
    capacity: null,
    sortOrder: id,
    renewMode: 'RESET',
    extraVolumeMinGb: null,
    extraTimeMinDays: null,
    newcomersOnly: false,
    renewEnabled: true,
    usernameMode: 'TELEGRAM_ID',
    usernameText: null,
    trial: { enabled: false, volumeGb: null, durationHours: null },
    extraVolumeTomanPerGb: { f: null, n: null, n2: null },
    extraTimeTomanPerDay: { f: null, n: null, n2: null },
    downgradeGroupIds: [],
    hasSecretRef: true,
    productCount: 0,
    planCount: 0,
    liveSubscriptions: 0,
  };
}

const A = panel(1, 'alpha', 'پنل آلفا');
const B = panel(2, 'beta', 'پنل بتا');

const panels = vi.fn(async () => ({ ok: true as const, items: [A, B] }));
/**
 * Comes back DISABLED and with no probe, so `statusNote` produces one
 * distinctive sentence rather than the bare «ذخیره شد.» that half the screen
 * could also be saying. The note is the only place that sentence exists — it is
 * computed from the response and never fetched again, which is exactly why a
 * remount loses it for good.
 */
const CREATED: PanelItem = { ...panel(3, 'gamma', 'پنل گاما'), status: 'DISABLED' };
const CREATED_NOTE = 'ذخیره شد — این پنل غیرفعال است و سفارشی از آن تحویل نمی‌شود.';
const createPanel = vi.fn(async () => ({ ok: true as const, panel: CREATED }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      panels: () => panels(),
      createPanel: () => createPanel(),
      panelGroups: async () => ({ ok: true, selected: [], available: [] }),
      panelHiddenUsers: async () => ({ ok: true, users: [] }),
      panelCredentialUsername: async () => ({ ok: true, username: null, setBy: null }),
    },
  };
});

function draw() {
  render(
    <RoleProvider role="ADMIN">
      <PanelsPage onGo={() => {}} />
    </RoleProvider>,
  );
}

/** The «نام پنل» box, whichever panel the dialog currently belongs to. */
function nameBox(): HTMLInputElement {
  return screen.getByLabelText(/نام پنل/) as HTMLInputElement;
}

beforeEach(() => {
  panels.mockClear();
  createPanel.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('the panel edit dialog', () => {
  it('shows the second panel when it is opened over the first', async () => {
    draw();
    await screen.findByText('پنل آلفا');

    const edits = screen.getAllByRole('button', { name: 'ویرایش' });
    fireEvent.click(edits[0]!);
    await waitFor(() => expect(nameBox().value).toBe('پنل آلفا'));

    // Without closing it — the whole point. The dialog stays mounted and only
    // its `panel` prop changes, which is the case a missing `key` gets wrong.
    // Asserted directly rather than through `waitFor`: the failure is a value
    // that is wrong now, not one that has not arrived yet, and waiting for it
    // reports a five-second timeout instead of «پنل آلفا».
    fireEvent.click(screen.getAllByRole('button', { name: 'ویرایش' })[1]!);
    expect(nameBox().value).toBe('پنل بتا');
  });

  it('keeps the status note when creating turns the dialog into the editor', async () => {
    draw();
    await screen.findByText('پنل آلفا');

    fireEvent.click(screen.getByRole('button', { name: /افزودن پنل/ }));
    fireEvent.change(nameBox(), { target: { value: 'پنل گاما' } });
    fireEvent.change(screen.getByLabelText(/کد/), { target: { value: 'gamma' } });
    fireEvent.click(screen.getByRole('button', { name: /^ذخیره$/ }));

    // `onSaved` hands the created panel back and the page sets it as `editing`,
    // so this dialog is now panel 3's editor. It must not have been remounted:
    // the note is the answer to «did it come up?» and is not fetched again.
    await waitFor(() => expect(createPanel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(CREATED_NOTE)).not.toBeNull());
    expect(nameBox().value).toBe('پنل گاما');
  });
});
