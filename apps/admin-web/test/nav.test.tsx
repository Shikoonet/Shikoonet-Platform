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

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NAV, navItem, pageLabel, type PageId } from '../src/nav.js';
import { App } from '../src/App.js';

const ALL: PageId[] = NAV.flatMap((g) => g.items.map((i) => i.id));

describe('navigation', () => {
  it('has no duplicate ids across the three groups', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it('keeps the groups and their order from the panel this replaces', () => {
    expect(NAV.map((g) => g.label)).toEqual(['منوی اصلی', 'مدیریت', 'پیکربندی']);
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
    // All twelve. The last two arrived with migration 0015, which gave the
    // bot's wording and keyboard a table of their own — they had none before,
    // in Postgres or in the production dump.
    const implemented: PageId[] = [
      'dashboard',
      'customers',
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
    ];
    expect([...ALL].sort()).toEqual([...implemented].sort());
  });
});

describe('the shell', () => {
  it('renders every section as a link, and promises nothing', () => {
    render(<App />);
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

  it('opens on the dashboard', () => {
    render(<App />);
    const active = document.querySelector('.sidebar-link.active');
    expect(active?.textContent).toContain('داشبورد');
  });
});
