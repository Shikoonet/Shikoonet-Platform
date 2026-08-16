/**
 * The two panels are one panel.
 *
 * This replaces `test/hub/app-nav.test.tsx`, which asserted the payment hub's
 * own tab bar, its mobile drawer and its operator-menu section list — three
 * pieces of navigation that existed because the hub was a separate build with
 * no sidebar of its own. All three are gone; keeping their tests would have
 * meant keeping them.
 *
 * What is asserted instead is the thing the merge was for, and each of these
 * was impossible before it:
 *
 *   - one sidebar reaches both surfaces
 *   - a finance screen has an address, so it can be sent to somebody
 *   - Back walks between the two surfaces like one application
 *   - the hub's chrome offers no second way to change section
 *
 * The last one is not tidiness. Two menus with the same six destinations is how
 * the panels drifted apart the first time, and it is the failure that would
 * look most like success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App.js';

/**
 * Signed in as ADMIN, with enough of a payments payload for the finance screen
 * to render — and a refusal for everything else.
 *
 * Refusing is not laziness, it is the safer half. An `{ok: true, items: []}`
 * handed to every request is read by the dashboard as an overview, and it
 * throws inside render on a field that is not there — an uncatchable error that
 * fails whichever test happened to be running. A rejection is caught by the
 * screen that made the call, which is what these tests need: the navigation
 * draws, and the body behind it is not the subject.
 */
function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

      if (url.endsWith('/me')) return json({ ok: true, email: 'a@b.c', role: 'ADMIN' });
      if (url.includes('/api/v1/payments')) {
        return json({
          ok: true,
          tab: 'income',
          range: 'all',
          items: [],
          counts: {
            needsReview: 0,
            waiting: 0,
            suspectedFake: 0,
            autoVerified: 0,
            botAutoVerified: 0,
            income: 0,
            reseller: 0,
            all: 0,
          },
          summary: {
            range: 'all',
            bankIncomeIrr: 0,
            botAutoVerified: { payments: 0, amountIrr: 0 },
            reseller: { payments: 0, amountIrr: 0, activeResellers: 0 },
            unassignedIncome: { count: 0, amountIrr: 0 },
          },
        });
      }
      return Promise.reject(new Error(`not stubbed: ${url}`));
    }),
  );
}

async function sidebar() {
  await waitFor(() => expect(document.querySelector('.sidebar-link')).toBeTruthy());
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one panel', () => {
  it('reaches the finance screens from the same sidebar as the shop screens', async () => {
    render(<App />);
    await sidebar();

    // Both groups, in one menu. Before the merge «پرداخت‌ها» lived in a
    // different bundle behind a different Cloudflare Access application, and no
    // sidebar in this codebase could name it.
    expect(screen.getByRole('button', { name: /پرداخت‌ها/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /کاربران/ })).toBeTruthy();
  });

  it('gives a finance screen an address, and Back returns to the panel', async () => {
    render(<App />);
    await sidebar();

    fireEvent.click(screen.getByRole('button', { name: /پرداخت‌ها/ }));
    await screen.findByRole('tablist', { name: 'بخش‌های پرداخت' });
    expect(window.location.pathname).toBe('/payments');

    // `popstate` rather than a re-render: this is the browser's own Back, which
    // is the thing that did not work when the section lived in `useState`.
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() =>
      expect(document.querySelector('.sidebar-link.active')?.textContent).toContain('داشبورد'),
    );
  });

  it('opens the section named in the URL rather than the front page', async () => {
    // What a shared link has to do. Nothing about the old panel could: every
    // screen was `/admin/`, so «look at this» could only ever be an instruction.
    window.history.replaceState(null, '', '/accounts');
    render(<App />);
    await sidebar();

    const active = document.querySelector('.sidebar-link.active');
    expect(active?.textContent).toContain('حساب‌ها');
  });

  it('carries a deep link’s query across a section change', async () => {
    // The notification bell's whole job: «two hundred unassigned income rows»
    // means the payments screen *on the income tab*, and that tab only exists
    // in `?tab=`. The first wiring wrote the query and then pushed a path
    // without one, so every bell entry landed on whichever tab was the default
    // — the section was right and the destination was not.
    render(<App />);
    await sidebar();

    fireEvent.click(screen.getByRole('button', { name: /امروز/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/today'));

    fireEvent.click(await screen.findByRole('button', { name: /اعلان‌ها/ }));
    // The panel lists one entry per payment bucket; «Income» is the one whose
    // destination differs from the default, which is what makes it the case
    // worth asserting.
    const entries = await screen.findAllByRole('button', { name: /واریزی/i });
    fireEvent.click(entries[0]!);

    await waitFor(() => expect(window.location.pathname).toBe('/payments'));
    expect(window.location.search).toBe('?tab=income');
  });

  it('leaves the hub with no second way to change section', async () => {
    render(<App />);
    await sidebar();
    fireEvent.click(screen.getByRole('button', { name: /پرداخت‌ها/ }));
    await screen.findByRole('tablist', { name: 'بخش‌های پرداخت' });

    // The operator menu survives — it refreshes every view and switches the
    // theme. What it must not do any more is offer «Statistics», «Devices» and
    // the rest a second time, one row below the sidebar that already has them.
    fireEvent.click(screen.getByRole('button', { name: 'منوی اپراتور' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'تازه‌سازی همهٔ نماها' })).toBeTruthy();
    for (const gone of ['Statistics', 'Today', 'Devices', 'Accounts', 'Banks']) {
      expect(within(menu).queryByRole('menuitem', { name: gone })).toBeNull();
    }
  });
});
