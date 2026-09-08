/**
 * The page in the address bar.
 *
 * The panel had twelve sections in `useState` and the payment hub had six, and
 * neither could be linked to: every screen was `/admin/` or `/`, so an admin
 * asking a colleague to look at a payment could only describe where to click.
 * With twenty-two sections in one panel that stops being an inconvenience.
 *
 * No router package. The pattern was already in this repository —
 * `hub/paymentsNav.tsx` keeps the payment tab in `?tab=` with `replaceState`
 * and a `popstate` listener — and generalising it is sixty lines against a
 * dependency, a `<Routes>` tree, and a server that has to learn every path.
 * The server's side of it is one line it already had: `/admin/*` answers
 * index.html.
 *
 * `pushState` rather than `replaceState`, and that is the difference that
 * matters: the browser's Back button walks the sections. `paymentsNav` uses
 * `replaceState` on purpose for the sub-tab, so Back leaves the payments screen
 * instead of stepping through nine tabs, and that stays as it is.
 */

import { useCallback, useEffect, useState } from 'react';
import { brand } from './brand.js';
import { isPageId, pageLabel, type PageId } from './nav.js';

/**
 * Where this build is mounted — `/admin` in the deployed panel, `/` under
 * vitest. Vite substitutes `BASE_URL` from `vite.config.ts` at build time, so
 * the two agree without either being written down twice.
 */
const BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/+$/, '');

export function pageFromPath(path: string): PageId {
  const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path;
  const first = rest.replace(/^\/+/, '').split('/')[0] ?? '';
  return isPageId(first) ? first : 'dashboard';
}

export function pathForPage(id: PageId): string {
  return id === 'dashboard' ? `${BASE}/` : `${BASE}/${id}`;
}

/**
 * The current section, and a way to go to another one.
 *
 * `navigate` takes an optional query string because some destinations are more
 * specific than a section. The notification bell says «two hundred unassigned
 * income rows» and means the payments screen *on the income tab*, and that tab
 * lives in `?tab=` — `PaymentsView` reads it on mount and on `popstate` and
 * nowhere else. Without the query riding along, every bell entry landed on
 * whichever tab happened to be the default.
 */
export function useRoute(): [PageId, (id: PageId, search?: string) => void] {
  const [page, setPage] = useState<PageId>(() => pageFromPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * The section, in the browser tab.
   *
   * Until now every one of the thirty-one screens set the same title, so a
   * bookmark, a restored window and a second tab opened on a payment were
   * indistinguishable from one another — and browser history, which is the
   * cheapest way back to a screen you had open an hour ago, listed the panel
   * thirty-one times under one name.
   *
   * Here rather than in each page: the section is already known here, and a
   * title written per page is a title that goes missing on the next page
   * somebody adds. The brand comes second because the section is what the
   * operator is looking for in a row of truncated tabs.
   */
  useEffect(() => {
    document.title = `${pageLabel(page)} · ${brand()}`;
  }, [page]);

  const navigate = useCallback((id: PageId, search = '') => {
    const path = pathForPage(id);
    const next = `${path}${search}`;

    if (path !== window.location.pathname) {
      window.history.pushState(null, '', next);
    } else if (next !== `${window.location.pathname}${window.location.search}`) {
      // Staying in the section, changing only what it is showing. Replace, so
      // Back leaves the screen instead of stepping backwards through nine
      // sub-tabs — the same call `paymentsNav` makes for the same reason.
      window.history.replaceState(null, '', next);
    }

    // Neither `pushState` nor `replaceState` fires `popstate`, and the screens
    // that keep state in the query — the payment sub-tab, the bot-verified
    // filter, table sort — listen for exactly that. A section change remounts
    // them, so their own mount-time read covers it; a change *within* a section
    // does not, and without this the address bar and the screen disagree. That
    // was the bell's oldest bug: clicking it while already on payments moved
    // nothing at all.
    if (search) window.dispatchEvent(new PopStateEvent('popstate'));

    setPage(id);
  }, []);

  return [page, navigate];
}
