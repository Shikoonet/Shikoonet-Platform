/**
 * The navigation and what actually renders behind it must agree.
 *
 * `built: false` draws a «به‌زودی» badge. If somebody ships a page and forgets
 * to flip the flag, the panel tells the admin a working screen is not ready;
 * if they flip it without shipping, the admin clicks into an empty page. Both
 * are silent, and neither shows up in a typecheck — so the flag is compared
 * against what `App` renders, not trusted on its own.
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

  it('marks exactly the sections that have a screen as built', () => {
    // The list of implemented pages, kept by hand — this is the assertion, so
    // it must not be derived from the same flag it is checking.
    const implemented: PageId[] = ['dashboard', 'customers', 'products', 'panels', 'discounts'];
    const flagged = ALL.filter((id) => navItem(id)!.built);
    expect(flagged.sort()).toEqual([...implemented].sort());
  });
});

describe('the shell', () => {
  it('renders every section as a link, with «به‌زودی» only on the unbuilt ones', () => {
    render(<App />);
    for (const group of NAV) {
      for (const item of group.items) {
        const link = screen.getByRole('button', { name: new RegExp(item.label) });
        expect(link).toBeTruthy();
        expect(link.textContent?.includes('به‌زودی')).toBe(!item.built);
      }
    }
  });

  it('opens on the dashboard', () => {
    render(<App />);
    const active = document.querySelector('.sidebar-link.active');
    expect(active?.textContent).toContain('داشبورد');
  });
});
