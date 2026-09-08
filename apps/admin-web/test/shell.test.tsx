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

/**
 * Every screen names itself, once, in a real heading.
 *
 * Walking staging on 2026-09-09 (`v8a7c470`) counted the `h1` elements on
 * «کاربران», «پرداخت‌ها» and «آمار مالی» and found **zero** on all three. The
 * panel's titles are `<div className="page-head__title">` — twenty-four of
 * them — and the shell's own title is a `div` too, so a screen reader
 * navigating by heading finds nothing to land on anywhere in the panel.
 *
 * `theme.css` already knew: the comment above `.page-head__title` says «a page
 * title is not a `div` — a screen reader navigating by heading has to be able
 * to find it», and the rule carries the `margin: 0` that a real heading needs.
 * Two pages out of twenty-six took it up. This is the rest.
 *
 * The heading is the SHELL's title rather than the page's, because that is the
 * one element all thirty-one screens have: six of them are finance screens with
 * no `.page-head` at all, and giving each its own would be six chances to
 * forget the seventh.
 */
describe('every screen has one heading, and it names the screen', () => {
  // A panel page whose title is a `div`; a page that already had its own `h1`
  // and would otherwise now have two; and two finance screens that have no page
  // title at all. If the claim holds anywhere it has to hold on all four.
  const SCREENS = ['کاربران', 'نمایندگان', 'پرداخت‌ها', 'آمار مالی'];

  it('puts the section name in exactly one h1', SHELL, async () => {
    await drawApp();
    for (const label of SCREENS) {
      await go(label);
      await waitFor(() =>
        expect([...document.querySelectorAll('h1')].map((h) => h.textContent?.trim())).toEqual([
          label,
        ]),
      );
    }
  });

  it('does not print the section name a third time as a breadcrumb', SHELL, async () => {
    // «کاربران» appeared three times on the 2026-09-09 screenshot: the sidebar's
    // active item, the header title, and «شیکو / کاربران» directly under it.
    await drawApp();
    await go('کاربران');
    expect(document.querySelector('.app-header__crumb')).toBeNull();
  });

  it('draws one header on a finance screen too, not four', SHELL, async () => {
    // The test above this block asserts «exactly one header» on «پرداخت‌ها»
    // alone, and passes — while «آمار مالی» was serving four, because the hub's
    // statistics view kept a page header of its own with a second copy of the
    // title and a second date control. A guard that checks one of the screens
    // its claim covers is not a guard.
    await drawApp();
    await go('آمار مالی');
    await waitFor(() => expect(document.querySelectorAll('header.app-header')).toHaveLength(1));
    expect(document.querySelector('#main-content .page-header')).toBeNull();
  });
});
