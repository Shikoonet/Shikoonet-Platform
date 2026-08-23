/**
 * The two write rules, and the fact that they are two.
 *
 * `write-roles.test.ts` in the worker asks all 114 write routes what they say
 * to a READ_ONLY and to a REVIEWER. That is the boundary and it is proven
 * there. This file asks the other question, which nothing asked until now:
 * **is the control drawn at all**, for a role the server is going to refuse.
 *
 * The reason it needs its own file is that the answer is not one rule. Under
 * `/api/v1/admin/` only an ADMIN writes — a REVIEWER is refused the catalogue
 * exactly as a reader is. On the payments surface a REVIEWER writes, because
 * approving a claim is the whole job that role exists for. A single «can this
 * operator write» would be wrong for one of the two, whichever way it was
 * written, and the first version of `role.tsx` was wrong in precisely that way.
 *
 * The assertions are on the rendered button, not on the hook's return value: a
 * hook that answers correctly and a page that never spreads its answer look the
 * same from inside the hook.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CatalogPage } from '../src/pages/CatalogPage.js';
import type { PanelRole } from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      catalog: vi.fn(async () => ({
        ok: true,
        total: 0,
        page: 1,
        pageSize: 25,
        items: [],
        panels: [],
      })),
      productCategories: vi.fn(async () => ({ ok: true, items: [] })),
    },
  };
});

/** The house convention: read `.disabled` off the element, no jest-dom. */
async function button(name: string): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name })) as HTMLButtonElement;
}

function renderAs(role: PanelRole | null) {
  return render(
    <RoleProvider role={role}>
      <CatalogPage />
    </RoleProvider>,
  );
}

/** The catalogue's write entry point, by the label an admin reads. */
const NEW_PRODUCT = 'سرویس تازه';
/** A read on the same screen, as the control that must NOT move. */
const SEARCH = 'جست‌وجو';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the admin surface — /api/v1/admin/*', () => {
  it('offers the write to an ADMIN', async () => {
    renderAs('ADMIN');
    expect((await button(NEW_PRODUCT)).disabled).toBe(false);
  });

  it('refuses a REVIEWER, who reviews payments and does not run the shop', async () => {
    // The case a single rule gets wrong. `write-roles.test.ts` proves the
    // server answers 403 here; without this the panel would still draw the
    // button and the 403 would arrive as a red bar after the click.
    renderAs('REVIEWER');
    expect((await button(NEW_PRODUCT)).disabled).toBe(true);
  });

  it('refuses a READ_ONLY operator', async () => {
    renderAs('READ_ONLY');
    expect((await button(NEW_PRODUCT)).disabled).toBe(true);
  });

  it('leaves the reads alone, which is the point of showing the page at all', async () => {
    // A rule that disabled everything would pass all three assertions above and
    // hand a reviewer a screen they cannot even filter. The search box is the
    // control that proves the disabling is aimed rather than blanket.
    renderAs('READ_ONLY');
    expect((await button(SEARCH)).disabled).toBe(false);
  });

  it('draws the control normally when no provider says otherwise', async () => {
    // The default every existing unit test renders under. Unknown role means
    // unknown, and the server is what refuses — guessing «disabled» here would
    // make a screen nobody ever sees the one the tests describe.
    render(<CatalogPage />);
    expect((await button(NEW_PRODUCT)).disabled).toBe(false);
  });
});
