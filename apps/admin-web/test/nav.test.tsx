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
  it('has no duplicate ids across the groups', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it('gives no word two meanings', () => {
    // The sidebar had «سرویس‌ها» meaning customer subscriptions while two
    // other screens used the same word for a product and for a panel tier, and
    // «محصولات» listing rows that were plans. An operator could not tell
    // from any label which of the three a screen was about, and reported the
    // whole area as incomprehensible — correctly.
    //
    // پنل · سرویس · کانفیگ · اشتراک, one meaning each.
    const labels = NAV.flatMap((g) => g.items.map((i) => i.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(pageLabel('catalog')).toBe('سرویس‌ها');
    expect(pageLabel('subscriptions')).toBe('اشتراک‌های مشتری');
    // Exactly one section is called «سرویس‌ها», and it is the catalogue.
    expect(labels.filter((l) => l === 'سرویس‌ها')).toHaveLength(1);
  });

  it('groups by the job, so nothing is split across two groups', () => {
    // Until 2026-08-30 the groups were inherited from `panel/header.php`
    // («منوی اصلی · مدیریت · پول · پیکربندی») so muscle memory would survive
    // the move. It cost a real thing: Sam went looking for the expense ledger
    // and could not find it, because «هزینه‌ها» was the tenth of eleven items
    // in «منوی اصلی» while the rest of the money lived in «پول».
    expect(NAV.map((g) => g.label)).toEqual([
      'گزارش‌ها',
      'مشتری و فروش',
      'کاتالوگ',
      'پول',
      'ربات',
      'سیستم',
    ]);

    // The assertion that is actually about the complaint, and the reason this
    // test is written as a subject-to-group map rather than as a list of
    // positions: a screen moving WITHIN its group is a taste change, and a
    // screen leaving its group is the regression. Written this way, only the
    // second one goes red.
    const groupOf = (id: PageId) => NAV.find((g) => g.items.some((i) => i.id === id))!.label;
    for (const id of ['payments', 'today', 'transactions', 'expenses', 'accounts', 'banks', 'devices'] as const) {
      expect(groupOf(id), `${id} belongs with the money`).toBe('پول');
    }
    for (const id of ['panels', 'catalog', 'products', 'categories', 'discounts', 'stock'] as const) {
      expect(groupOf(id), `${id} belongs with the catalogue`).toBe('کاتالوگ');
    }
    // The two «آمار» screens name different subjects and must be read side by
    // side, or the second one reads as a duplicate of the first.
    expect(groupOf('stats')).toBe(groupOf('statistics'));

    // داشبورد still opens the panel.
    expect(NAV[0]!.items[0]!.id).toBe('dashboard');
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
      // «آمار فروشگاه», 2026-08-29. The eighteen figures the PHP bot draws
      // under «آمار کلی ربات», of which the dashboard home had five and none
      // of its seven periods. Distinct from «آمار مالی» in the پول group:
      // that one counts bank transactions, this one counts the shop's trade.
      'stats',
      // «ارسال گروهی» — the two actions that reach every customer at once, and
      // the last two of the bot admin panel's twelve permissions to get a web
      // screen. See `bot-subset.test.ts`.
      'bulk',
      'catalog',
      // «محصولات» and «دسته‌بندی‌ها», 2026-08-27. The flat price list the panel
      // being replaced calls «محصولات», and the category table that has been in
      // the schema since 0002 with no screen at all — which stopped being
      // harmless the day the bot's first screen became the category list.
      'products',
      'categories',
      'panels',
      'discounts',
      'orders',
      'subscriptions',
      'transactions',
      'requests',
      'settings',
      'texts',
      'keyboard',
      'access',
      // «رویدادها» — `app_events`, which migration 0030 filled from
      // 2026-08-22 and only `psql` could read.
      'events',
      // «ربات», 2026-08-29 — which bot the shop is. The token used to live only
      // in the process environment, so this was the one operational fact the
      // panel could neither show nor change, and «تنظیمات» cannot hold it:
      // `SECRET_KEY_PATTERN` matches `token` and refuses the read and the write.
      'bot',
      // «ایمپورت میرزابات» — the legacy MySQL dump, brought in from the panel
      // rather than from a terminal nobody doing a cutover has.
      'import',
      // «کرون‌جاب‌ها» — the sweeps the bot runs on its own. Until this screen
      // there was no list of them anywhere outside TypeScript, and no switch:
      // an admin could not stop the shop warning customers, and could not see
      // that two jobs the PHP bot deletes services with had never been built.
      'cron',
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
