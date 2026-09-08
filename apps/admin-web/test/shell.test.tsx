/**
 * One header, on every screen.
 *
 * The 2026-09-07 walk found the panel wearing two shells. Six finance screens
 * carried a second header of their own — with the notification bell, the
 * continuity control and a date navigator — and the other twenty-five carried
 * none of it. So «آیا پرداختی رسیده؟» was answerable from «امروز» and not from
 * «کاربران», which makes the bell a property of a section rather than of the
 * panel.
 *
 * Everything below is asserted from `<App/>` rather than from the header
 * component, because the claim is «on every screen» and only the app knows
 * which screens exist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

const signedIn = () =>
  vi.fn(async (url: string) =>
    String(url).endsWith('/me')
      ? { ok: true, status: 200, json: async () => ({ ok: true, email: 'a@b.c', role: 'ADMIN' }) }
      : // Everything else refuses, exactly as `nav.test.tsx` does it: each screen
        // catches its own failure and the shell still draws, which is what is
        // under test.
        Promise.reject(new Error('not stubbed')),
  );

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', signedIn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/*
 * Fifteen seconds per test, and the reason is arithmetic rather than slowness.
 *
 * `test/setup.ts` gives every `findBy`/`waitFor` five seconds, which is the
 * same as vitest's default per-test budget — so one retry loop that never
 * settles eats the whole test and it dies as «timed out» before reaching a
 * single assertion. Every failure here then looks identical and says nothing.
 */
const SHELL = { timeout: 15_000 };

const drawApp = async () => {
  render(<App />);
  await waitFor(() => expect(document.querySelector('.sidebar-link')).toBeTruthy());
};

const go = async (label: string) => {
  // The sidebar entries are buttons, not anchors — `nav.test.tsx` navigates the
  // same way.
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(label) }));
  await waitFor(() => expect(document.querySelector('.sidebar-link.active')).toBeTruthy());
};

describe('the panel has one header', () => {
  it('carries the notification bell on a screen that is not a finance one', SHELL, async () => {
    await drawApp();
    await go('کاربران');
    // The bell polls and its request is refused by the stub; it must still
    // mount. A control that disappears when its own read fails is a control
    // nobody can rely on.
    await waitFor(() => expect(screen.getByRole('button', { name: /اعلان/ })).toBeTruthy());
  });

  it('draws exactly one header element, not one per shell', SHELL, async () => {
    await drawApp();
    await go('پرداخت‌ها');
    await waitFor(() => expect(document.querySelectorAll('header')).toHaveLength(1));
  });

  it('keeps the bell across a move between the two old shells', SHELL, async () => {
    await drawApp();
    await go('پرداخت‌ها');
    await waitFor(() => expect(screen.getByRole('button', { name: /اعلان/ })).toBeTruthy());
    await go('سفارشات');
    await waitFor(() => expect(screen.getByRole('button', { name: /اعلان/ })).toBeTruthy());
  });
});
