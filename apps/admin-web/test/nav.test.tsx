/**
 * The navigation and what actually renders behind it must agree.
 *
 * There used to be a `built: false` flag here drawing a «به‌زودی» badge, and
 * this file existed to stop it drifting from what `App` actually renders. Both
 * are gone: every section has a screen, so `App`'s switch has no default arm
 * and a section added to `nav.ts` without one is a type error.
 *
 * What the compiler still cannot see is the other direction — a `PageId` with a
 * screen but no row in `NAV` is a page no admin can reach, and nothing about it
 * looks broken. That is what the hand-kept list below is for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NAV, navItem, pageLabel, type PageId } from '../src/nav.js';
import { App } from '../src/App.js';

const ALL: PageId[] = NAV.flatMap((g) => g.items.map((i) => i.id));

describe('navigation', () => {
  it('has no duplicate ids across the three groups', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it('keeps the groups and their order from the panel this replaces', () => {
    // «پول» is the payment hub, which was its own build at `/` until
    // 2026-08-16. Sam placed it third after seeing the merged sidebar; the
    // other three keep the order they had in `panel/header.php`.
    expect(NAV.map((g) => g.label)).toEqual(['منوی اصلی', 'مدیریت', 'پول', 'پیکربندی']);
    expect(NAV[2]!.items[0]!.id).toBe('payments');
    // داشبورد first and کاربران second is the order an admin's hand already
    // knows; reordering it is a decision, not a refactor.
    expect(NAV[0]!.items.slice(0, 2).map((i) => i.id)).toEqual(['dashboard', 'customers']);
  });

  it('labels every section', () => {
    for (const id of ALL) {
      expect(pageLabel(id)).not.toBe('');
      expect(navItem(id)?.icon).toBeTruthy();
    }
  });

  it('lists every section that has a screen, so none is unreachable', () => {
    // The list of pages with a screen, kept by hand — this is the assertion, so
    // it must not be derived from `NAV` itself.
    // `texts` and `keyboard` arrived with migration 0015, which gave the bot's
    // wording and keyboard a table of their own. `content` is the two tables the
    // bot has read since «آموزش» was built and nobody could edit: `help_articles`
    // and `client_apps` were changed in the legacy admin panel until 2026-08-16.
    const implemented: PageId[] = [
      // The six that came from the payment hub on 2026-08-16. They are listed
      // here for the same reason as the rest: a screen `App` can draw but `NAV`
      // does not name is a screen nobody can reach, and it looks fine.
      'payments',
      'statistics',
      'today',
      'accounts',
      'banks',
      'devices',
      'content',
      'stock',
      // `revenue_adjustments` arrived with migration 0005 and nothing read a row
      // of it until 2026-08-16; production has 136 entries that would have
      // migrated in and stayed invisible.
      'expenses',
      'dashboard',
      'customers',
      // «ارسال گروهی» — the two actions that reach every customer at once, and
      // the last two of the bot admin panel's twelve permissions to get a web
      // screen. See `bot-subset.test.ts`.
      'bulk',
      'products',
      'panels',
      'discounts',
      'orders',
      'services',
      'transactions',
      'requests',
      'settings',
      'texts',
      'keyboard',
      'access',
      // «رویدادها» — `app_events`, which migration 0030 filled from
      // 2026-08-22 and only `psql` could read.
      'events',
    ];
    expect([...ALL].sort()).toEqual([...implemented].sort());
  });
});

describe('the shell', () => {
  // The panel now waits for `/api/v1/auth/me` before drawing anything: signed
  // out it shows the login form instead. Without an answer here these two would
  // assert against that form and fail for a reason that has nothing to do with
  // navigation.
  // A plain object rather than `new Response(...)`: what `api.ts` touches is
  // `ok`, `status` and `json()`, and building a real Response here made the
  // stub itself throw — which sent the panel down the signed-out path and made
  // the login test below pass for the wrong reason.
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

  // Only `/me` is answered. Handing the identity payload to every other request
  // is worse than refusing them: the dashboard reads it as an overview and
  // throws, so the shell never finishes rendering. Refusing is also what these
  // tests saw before the login existed — each screen catches its own failure
  // and the navigation still draws, which is the thing under test.
  const signedIn = () =>
    vi.fn(async (url: string) =>
      String(url).endsWith('/me')
        ? { ok: true, status: 200, json: async () => ({ ok: true, email: 'a@b.c', role: 'ADMIN' }) }
        : Promise.reject(new Error('not stubbed')),
    );

  beforeEach(() => {
    vi.stubGlobal('fetch', signedIn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the login form when nobody is signed in', async () => {
    // The other half: if `me` refuses, the panel must not draw itself. A shell
    // that renders behind a login form fires a dozen requests that all 401.
    vi.stubGlobal('fetch', answer(401, { ok: false, error: 'unauthorized' }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('ورود به پنل مدیریت')).toBeTruthy());
    expect(document.querySelector('.sidebar-link')).toBeNull();
  });

  it('renders every section as a link, and promises nothing', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('.sidebar-link')).toBeTruthy());
    for (const group of NAV) {
      for (const item of group.items) {
        const link = screen.getByRole('button', { name: new RegExp(item.label) });
        expect(link).toBeTruthy();
      }
    }
    // No «به‌زودی» anywhere: a badge left behind after the section it belonged
    // to was built tells the admin a working screen is not ready.
    expect(document.body.textContent).not.toContain('به‌زودی');
  });

  it('opens on the dashboard', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('.sidebar-link.active')).toBeTruthy());
    const active = document.querySelector('.sidebar-link.active');
    expect(active?.textContent).toContain('داشبورد');
  });
});
