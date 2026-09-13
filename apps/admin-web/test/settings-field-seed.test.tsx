/**
 * A pick that lands before React has run the field's mount effect.
 *
 * `SettingField` re-seeds its draft from the row so a reload shows what the
 * server kept. When that re-seed was a `useEffect`, the mount run of it was
 * deferred past paint — and a click that landed in between was overwritten by
 * it: the effect's `setDraft('')` queued behind the click's `setDraft(next)`
 * and won. `findByLabelText` returns the moment the input exists, so on a
 * loaded CI runner the ordinary test hit that window at random (issue #168,
 * third face: «expected '' to be '{name}'», 110 ms, no timeout in sight).
 *
 * This test opens the window on purpose rather than hoping to land in it: no
 * `act`, a raw root, and the click fired from the MutationObserver callback
 * that sees the input appear — before the scheduler's next task, which is
 * where a passive effect runs. With the effect it was red every time; with
 * the render-time re-seed there is nothing left to run late.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { api, type SettingRow } from '../src/api.js';

const ROW: SettingRow = {
  scope: 'shop',
  key: 'plan_button_template',
  live: true,
  label: 'قالب دکمهٔ سرویس',
  hint: '',
  kind: 'text',
  secret: false,
  value: '',
  isSet: false,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: null,
};

const ACT_FLAG = 'IS_REACT_ACT_ENVIRONMENT';
let root: Root | null = null;
let host: HTMLElement | null = null;
let actWas: unknown;

beforeEach(() => {
  vi.spyOn(api, 'settings').mockResolvedValue({ ok: true, items: [ROW], hiddenCount: 0 });
  vi.spyOn(api, 'updateSetting').mockResolvedValue({ ok: true } as Awaited<
    ReturnType<typeof api.updateSetting>
  >);
  // Testing Library turns this on so React flushes everything inside `act`;
  // the whole point here is to let React schedule on its own.
  actWas = (globalThis as Record<string, unknown>)[ACT_FLAG];
  (globalThis as Record<string, unknown>)[ACT_FLAG] = false;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  (globalThis as Record<string, unknown>)[ACT_FLAG] = actWas;
  vi.restoreAllMocks();
});

it('keeps a pick that lands before the mount effects have run', async () => {
  const label = 'قالب دکمهٔ سرویس';
  const clicked = new Promise<HTMLInputElement>((resolve) => {
    const seen = new MutationObserver(() => {
      const input = Array.from(host!.querySelectorAll('label'))
        .find((l) => l.textContent === label)
        ?.control as HTMLInputElement | undefined;
      if (!input) return;
      seen.disconnect();
      // Synchronously, inside the observer: the commit has happened, its
      // passive effects have not.
      const token = Array.from(host!.querySelectorAll('button')).find(
        (b) => b.textContent === '{name}',
      )!;
      fireEvent.click(token);
      resolve(input);
    });
    seen.observe(host!, { childList: true, subtree: true });
  });

  root = createRoot(host!);
  root.render(
    <RoleProvider role="ADMIN">
      <SettingsPage />
    </RoleProvider>,
  );

  const input = await clicked;
  // Let every scheduled task — the late effect included — run before looking.
  await new Promise((r) => setTimeout(r, 50));
  expect(input.value).toBe('{name}');
  expect(api.updateSetting).toHaveBeenLastCalledWith({
    scope: 'shop',
    key: 'plan_button_template',
    value: '{name}',
  });
});
