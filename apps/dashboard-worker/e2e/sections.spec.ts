/**
 * Every section of the panel, opened one at a time and watched while it loads.
 *
 * `panel.spec.ts` already walks all twenty-four and asserts that each becomes
 * active and that nothing answers 401 or 403. That catches a section that is
 * shut. It does not catch a section that opens and is broken, and those are the
 * ones an operator actually meets: a 500 from one of the four requests a screen
 * fires, a `TypeError` in a render that leaves the page half-drawn, an error
 * box where the table should be.
 *
 * So this file watches four things per section and reports every section that
 * failed rather than stopping at the first — a list of what is broken is worth
 * more than the name of whichever screen happens to sort earliest.
 *
 *   1. no response at 400 or above
 *   2. no `console.error` and no uncaught exception
 *   3. no visible `.alert-error`
 *   4. something was actually drawn
 *
 * The fourth is the weakest and is deliberately generous: an empty shop is a
 * legitimate state and half these screens can be empty on a fresh database, so
 * it asserts that the content area is not blank, not that it holds rows.
 */

import { expect, test, type Page } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

/**
 * Requests every screen makes that are allowed to fail, with the reason.
 *
 * Empty on purpose. A line added here is a decision that an operator seeing a
 * failed request is acceptable on that screen, and it should be as hard to add
 * as it is to read.
 */
const MAY_FAIL: ReadonlySet<string> = new Set<string>([]);

type Trouble = { section: string; what: string };

function watch(page: Page, current: () => string, into: Trouble[]): void {
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (MAY_FAIL.has(path)) return;
    into.push({ section: current(), what: `HTTP ${r.status()} ${path}` });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    into.push({ section: current(), what: `console.error: ${m.text().slice(0, 200)}` });
  });
  // Distinct from a console error: this is a render that threw, which React
  // answers by unmounting the tree. The page can look merely empty.
  page.on('pageerror', (e) => {
    into.push({ section: current(), what: `uncaught: ${String(e.message).slice(0, 200)}` });
  });
}

test('every section opens without a failed request, a thrown render or an error box', async ({
  page,
}) => {
  const trouble: Trouble[] = [];
  let section = '(before any section)';
  watch(page, () => section, trouble);

  await page.goto('/admin/');
  await expect(page.locator('.sidebar-link').first()).toBeVisible();

  const labels = (await page.locator('.sidebar-link').allInnerTexts()).map((l) => l.trim());
  // Twenty-four until «محصولات» and «دسته‌بندی‌ها» landed on 2026-08-27.
  // 28 -> 29 on 2026-08-30, and the sidebar did not change to make it so. The
  // set of items is byte-for-byte the one that existed before the regrouping
  // commit — `git show fe35ae7^:apps/admin-web/src/nav.ts` lists the same 29
  // ids — so this constant had been stale on `main` for some time, red in a
  // suite nobody could run because CI is off. Counted from `nav.ts` and checked
  // for duplicates, not adjusted until it went green.
  // 29 -> 30 on 2026-09-07 with «کرون‌جاب‌ها». Unlike the 28 -> 29 above,
  // this one IS a new section: the sidebar gained an item, so the number
  // moved for the reason a number should. Counted off `nav.ts`, which has
  // thirty `{ id:` entries.
  // 30 -> 31 on 2026-09-07 with «نمایندگان» — a new section, so the number
  // moved for the reason a number should. Counted off `nav.ts`.
  expect(labels.length).toBe(31);

  for (const label of labels) {
    section = label;
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.sidebar-link.active')).toHaveText(label);

    // Screens fetch on mount, so the assertions below have to happen after the
    // requests they are about. `networkidle` rather than a fixed wait: a slow
    // query on a full table would otherwise be read as a clean screen.
    await page.waitForLoadState('networkidle');

    const errorBox = page.locator('#main-content .alert-error');
    if (await errorBox.count()) {
      trouble.push({
        section: label,
        what: `error box: ${(await errorBox.first().innerText()).slice(0, 200)}`,
      });
    }

    const drawn = (await page.locator('#main-content').innerText()).trim();
    if (drawn === '') trouble.push({ section: label, what: 'drew nothing at all' });

    // A screen with no heading cannot be navigated by one, and on 2026-09-09
    // that was every screen: the panel's titles were `div`s and so was the
    // shell's. Asserted for all thirty-one rather than for a sample, because
    // the sample that was checked (`shell.test.tsx`, «پرداخت‌ها») passed while
    // «آمار مالی» was serving four headers and no heading at all.
    const headings = (await page.locator('h1').allInnerTexts()).map((t) => t.trim());
    if (headings.length !== 1) {
      trouble.push({ section: label, what: `${headings.length} h1: ${headings.join(' | ') || '(none)'}` });
    } else if (headings[0] !== label) {
      trouble.push({ section: label, what: `heading says «${headings[0]}», sidebar says «${label}»` });
    }

    const shells = await page.locator('header.app-header').count();
    if (shells !== 1) trouble.push({ section: label, what: `${shells} app headers` });
  }

  expect(trouble.map((t) => `${t.section} — ${t.what}`)).toEqual([]);
});

/**
 * The same walk on a phone, watching one thing: does the PAGE scroll sideways.
 *
 * A table wider than the screen is not this — `.table-wrap` scrolls on its own
 * and that is intended. What this catches is the document overflowing, which
 * takes the header, the sidebar toggle and every button on the screen out from
 * under the operator's thumb and cannot be scrolled back to on iOS without
 * pinching.
 *
 * ## Why this plants a long name first
 *
 * Walking staging at 390px on 2026-09-07 found «ارسال گروهی» over by 54px and
 * «قفسهٔ انبار» by 20px. Measuring which element did it named a `<select>` in
 * the filter bar both times — and the cause is not the filter bar's widths but
 * `width: auto` on the select, which means «as wide as your widest option».
 * Staging overflowed because a real panel is called «🥇سرویس تیتانیوم - مولتی
 * لوکیشن 🌍» and a real config «نقره‌ای — ۱ ماهه · ۵۰ گیگ · چند کاربره».
 *
 * On a seeded database every option is short and the page fits, so this test
 * written against `seed:sim` alone would have been green over the live defect —
 * exactly the shape of «a LIMIT that is not a limit», where a table with three
 * rows never gets the plan that shows the bug. So it plants one long name,
 * measures, and puts the name back.
 *
 * 390px is an iPhone 14/15/16 in portrait, and the width the finding was
 * measured at.
 */
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // Long enough that a select sized to it cannot fit a 390px screen, and
  // shaped like the real ones rather than like a stress string: this is a
  // production panel name from the 2026-09-07 walk.
  const LONG = '🥇سرویس تیتانیوم - مولتی لوکیشن 🌍 - چند کاربره - بدون محدودیت';

  async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
    const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
    try {
      return await fn(db);
    } finally {
      await pool.end();
    }
  }

  // Only these two tables are ever renamed, and the map is what the restore
  // statement reads its table name from — a name that reached SQL from a row
  // would be an injection point, however unlikely the row.
  type Renamed = { table: 'provisioning_providers' | 'product_plans'; id: number; name: string };

  // At module scope rather than assigned from the setup's return value: if the
  // second rename throws, the first has already happened and `afterAll` still
  // has to undo it. Assigning the whole array at the end means a half-finished
  // setup leaves a panel called «🥇سرویس تیتانیوم …» in the database for every
  // later run.
  const renamed: Renamed[] = [];

  async function restoreNames(): Promise<void> {
    if (renamed.length === 0) return;
    await withDb(async (d) => {
      // Spliced as it goes, so a failure part-way does not put the rows that
      // were already restored back on the list for a second attempt.
      while (renamed.length > 0) {
        const r = renamed[renamed.length - 1]!;
        const sql =
          r.table === 'product_plans'
            ? `UPDATE product_plans SET name = ?2 WHERE id = ?1`
            : `UPDATE provisioning_providers SET name = ?2 WHERE id = ?1`;
        await d.prepare(sql).bind(r.id, r.name).run();
        renamed.pop();
      }
    });
  }

  test.beforeAll(async () => {
    try {
      await withDb(async (d) => {
        // One provider, for «ارسال گروهی»'s panel filter, and one plan, for
        // «قفسهٔ انبار»'s config filter. Each is read back and recorded BEFORE
        // its own update, so whatever fails, what has changed is known.
        const provider = await d
          .prepare(`SELECT id, name FROM provisioning_providers ORDER BY id LIMIT 1`)
          .first<{ id: number; name: string }>();
        if (provider) {
          renamed.push({
            table: 'provisioning_providers',
            id: Number(provider.id),
            name: provider.name,
          });
          await d
            .prepare(`UPDATE provisioning_providers SET name = ?2 WHERE id = ?1`)
            .bind(provider.id, LONG)
            .run();
        }
        const plan = await d
          .prepare(`SELECT id, name FROM product_plans ORDER BY id LIMIT 1`)
          .first<{ id: number; name: string }>();
        if (plan) {
          renamed.push({ table: 'product_plans', id: Number(plan.id), name: plan.name });
          await d
            .prepare(`UPDATE product_plans SET name = ?2 WHERE id = ?1`)
            .bind(plan.id, LONG)
            .run();
        }
      });
    } catch (e) {
      await restoreNames();
      throw e;
    }
    expect(renamed.length, 'nothing to rename — run seed:sim').toBeGreaterThan(0);
  });

  test.afterAll(restoreNames);

  test('no section scrolls the page sideways', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.locator('.sidebar-link').first()).toBeVisible();

    const labels = (await page.locator('.sidebar-link').allInnerTexts()).map((l) => l.trim());
    const wide: string[] = [];

    for (const label of labels) {
      // The sidebar is a drawer at this width and covers the page, so it has
      // to be opened for the click and is closed by the navigation itself.
      await page.getByRole('button', { name: 'منو', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.locator('.sidebar-link.active')).toHaveText(label);
      await page.waitForLoadState('networkidle');

      const over = await page.evaluate(() => {
        const doc = document.documentElement;
        const main = document.querySelector('#main-content');
        return {
          doc: doc.scrollWidth - doc.clientWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      // One pixel of slack for sub-pixel rounding; anything an operator can
      // see is many.
      if (over.doc > 1) wide.push(`${label}: document over by ${over.doc}px`);
      if (over.main > 1) wide.push(`${label}: #main-content over by ${over.main}px`);
    }

    expect(wide).toEqual([]);
  });
});
