/**
 * «ایمپورت میرزابات» — the upload, walked the way an admin walks it.
 *
 * The unit suites already assert what the route does with a name and with a
 * body. What only a browser can prove is the part in between: that a real
 * `<input type="file">` on a real page, with the panel's own cookie and the
 * `Origin` header a browser actually sends, ends with the file on the server's
 * disk. `originGuard` refuses a POST with no Origin outside local, and an
 * upload built by `app.request()` in a unit test never had one to get wrong.
 *
 * So the assertion is the DISK, twice: the file is there afterwards with the
 * bytes that were chosen, and the page's own list — re-read from the server,
 * not from anything the page remembered — offers it.
 *
 * The `.sql` written here is a `SELECT 1`, not a dump. Nothing runs it: this
 * spec never presses «بررسی», because that would need the scratch MySQL and
 * would be re-testing `packages/migrate` through a browser.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { IMPORT_DIR } from '../playwright.config.js';

const NAME = 'e2e-upload.sql';
const BODY = '-- e2e\nSELECT 1;\n';
const target = join(IMPORT_DIR, NAME);

const wipe = () => {
  rmSync(target, { force: true });
  rmSync(`${target}.part`, { force: true });
};

test.beforeEach(wipe);
test.afterAll(wipe);

test('an admin puts a dump on the server from the browser', async ({ page }) => {
  await page.goto('/admin/import');
  await expect(page.locator('.sidebar-link.active')).toHaveText('ایمپورت میرزابات');

  await page.setInputFiles('input[type="file"]', {
    name: NAME,
    mimeType: 'application/sql',
    buffer: Buffer.from(BODY, 'utf8'),
  });

  // The page says it landed…
  await expect(page.getByText(`«${NAME}» روی سرور نشست`)).toBeVisible();

  // …and the disk agrees, which is the only one of the two that is evidence.
  expect(existsSync(target)).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(BODY);
  // Nothing half-written left over.
  expect(existsSync(`${target}.part`)).toBe(false);

  // The list is the server's answer, re-read after the upload. A page that
  // merely appended the name it just sent would pass an assertion about the
  // page and prove nothing about the directory.
  await expect(page.locator('select option', { hasText: NAME })).toHaveCount(1);
});

test('a file that is not a dump is refused, and nothing is written', async ({ page }) => {
  await page.goto('/admin/import');

  await page.setInputFiles('input[type="file"]', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a dump', 'utf8'),
  });

  await expect(page.locator('.alert-error')).toContainText('پسوند');
  expect(existsSync(join(IMPORT_DIR, 'notes.txt'))).toBe(false);
});
