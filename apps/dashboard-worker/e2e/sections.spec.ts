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
  expect(labels.length).toBe(24);

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
  }

  expect(trouble.map((t) => `${t.section} — ${t.what}`)).toEqual([]);
});
