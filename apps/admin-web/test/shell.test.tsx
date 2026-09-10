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
  // The sidebar remembers which groups are folded, and a leftover from the
  // previous test would decide this one.
  localStorage.clear();
  vi.stubGlobal('fetch', signedIn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
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

/**
 * The sidebar's groups fold, and remember that they did.
 *
 * Thirty-one sections in seven groups is a column taller than a laptop screen,
 * and an operator who lives on «پرداخت‌ها» scrolls past «کاتالوگ» all day. The
 * group headings were already there and already inert — this makes them the
 * control they look like.
 *
 * `<details>`/`<summary>` rather than a button and a conditional render: the
 * open/closed state, the keyboard handling and the disclosure semantics are the
 * element's, and the only thing left to write is remembering the choice.
 *
 * Only the memory is asserted from `localStorage` directly; the folding itself
 * is asserted from `details.open`, because a closed `<details>` still holds its
 * children in the DOM and «the links are gone» would be a claim about styling
 * that happy-dom does not apply.
 */
describe('the sidebar groups fold', () => {
  const groupOf = (label: string) =>
    screen.getByText(label, { selector: 'summary' }).closest('details')!;

  it('folds a group when its heading is pressed, and says so on disk', SHELL, async () => {
    await drawApp();
    await go('کاربران');
    const catalogue = groupOf('کاتالوگ');
    expect(catalogue.open).toBe(true);

    fireEvent.click(screen.getByText('کاتالوگ', { selector: 'summary' }));
    expect(catalogue.open).toBe(false);
    expect(JSON.parse(localStorage.getItem('sidebar.collapsed') ?? '[]')).toContain('کاتالوگ');
  });

  it('is still folded the next time the panel is opened', SHELL, async () => {
    localStorage.setItem('sidebar.collapsed', JSON.stringify(['کاتالوگ']));
    await drawApp();
    expect(groupOf('کاتالوگ').open).toBe(false);
    // Everything else stays open: a remembered choice about one group is not a
    // choice about the others, and `sections.spec.ts` counts the links.
    expect(groupOf('گزارش‌ها').open).toBe(true);
  });

  it('unfolds the group holding the section you have just opened', SHELL, async () => {
    // Otherwise arriving at «سرویس‌ها» — from a link, or from the address bar —
    // leaves the sidebar with no highlighted entry anywhere, which reads as
    // «this screen is not in the menu».
    localStorage.setItem('sidebar.collapsed', JSON.stringify(['کاتالوگ']));
    await drawApp();
    expect(groupOf('کاتالوگ').open).toBe(false);
    await go('سرویس‌ها');
    await waitFor(() => expect(groupOf('کاتالوگ').open).toBe(true));
  });
});

/**
 * The palette is mounted by the shell, not by a screen.
 *
 * Asserted from `<App/>` for the same reason everything else here is: the claim
 * is «from anywhere», and only the app knows what anywhere is. The component's
 * own behaviour — the debounce, the role filter, the arrow keys — is
 * `command-palette.test.tsx`; this is the wiring.
 */
describe('the panel can be told where to go', () => {
  it('opens the palette from a screen that is not the dashboard', SHELL, async () => {
    await drawApp();
    await go('پرداخت‌ها');
    expect(document.querySelector('dialog[open]')).toBeNull();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('dialog[open]')).toBeTruthy());
  });

  it('takes the keyboard to a section it names', SHELL, async () => {
    await drawApp();
    await go('پرداخت‌ها');
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('dialog[open]')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('نام بخش یا مشتری'), { target: { value: 'سفارشات' } });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.sidebar-link.active')?.textContent).toContain('سفارشات'));
    // And it closes behind itself, or the next keystroke goes into a box that
    // is still on top of the screen it just opened.
    expect(document.querySelector('dialog[open]')).toBeNull();
  });
});
