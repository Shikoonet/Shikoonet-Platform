/**
 * The front door, walked in a real browser.
 *
 * Everything else in `e2e/` runs against the server started with
 * `sim/.env.local`, which carries `TEST_ACCESS_USER` — that signs an identity in
 * before the form is ever drawn, so a login spec there would be asserting
 * against a panel that is already open. These run against the second server in
 * `playwright.config.ts`, which has no bypass and therefore has a real door.
 *
 * The reason to walk it rather than trust `operator-login.test.ts`: those tests
 * prove the routes. They cannot see whether the cookie the browser stores is
 * actually sent back, whether `credentials: 'include'` is on the fetch, or
 * whether the panel draws the form at all instead of a blank page with a dozen
 * failed requests behind it. Every one of those has been a real bug in this
 * repository.
 */

import { expect, test } from '@playwright/test';
import { LOGIN_EMAIL, LOGIN_PASSWORD } from './global-setup.js';

const BASE = 'http://127.0.0.1:8800';

test.use({ baseURL: BASE });

test('a signed-out visitor gets the form, not the panel', async ({ page }) => {
  await page.goto(`${BASE}/admin/`);
  await expect(page.getByText('ورود به پنل مدیریت')).toBeVisible();
  // The panel must not be behind it firing requests that all refuse.
  await expect(page.locator('.sidebar-link')).toHaveCount(0);
});

test('the wrong password is refused, and says nothing useful', async ({ page }) => {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(LOGIN_EMAIL);
  await page.getByLabel('رمز عبور').fill('definitely not the password');
  await page.getByRole('button', { name: 'ورود' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  // One sentence for every failure. Naming which half was wrong would tell an
  // attacker which addresses are real.
  await expect(page.getByRole('alert')).toHaveText('ایمیل یا رمز درست نیست.');
  await expect(page.locator('.sidebar-link')).toHaveCount(0);
});

test('the right password opens the panel, and it stays open on reload', async ({ page }) => {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(LOGIN_EMAIL);
  await page.getByLabel('رمز عبور').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();

  await expect(page.locator('.sidebar-link.active')).toContainText('داشبورد');

  // The reload is the assertion that matters. A login that works once and
  // forgets on refresh means the cookie is not being stored or not being sent,
  // which no route-level test can see.
  await page.reload();
  await expect(page.locator('.sidebar-link.active')).toContainText('داشبورد');
  await expect(page.getByText('ورود به پنل مدیریت')).toHaveCount(0);
});

test('signing out ends the session for good', async ({ page }) => {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(LOGIN_EMAIL);
  await page.getByLabel('رمز عبور').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.locator('.sidebar-link.active')).toBeVisible();

  await page.getByRole('button', { name: 'خروج' }).click();
  await expect(page.getByText('ورود به پنل مدیریت')).toBeVisible();

  // And it is the server that forgot, not just this tab: the cookie was
  // revoked, so a reload cannot get back in.
  await page.reload();
  await expect(page.getByText('ورود به پنل مدیریت')).toBeVisible();
});

test('the session cookie is not readable by script', async ({ page, context }) => {
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('ایمیل').fill(LOGIN_EMAIL);
  await page.getByLabel('رمز عبور').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.locator('.sidebar-link.active')).toBeVisible();

  // `operator-login.test.ts` asserts the attribute on the Set-Cookie header;
  // this is the browser agreeing that it stored it that way. An XSS that can
  // read this cookie can simply be the operator.
  //
  // Read through the browser context rather than `document.cookie`: this file
  // is typechecked with Node's libs, where `document` does not exist.
  const cookie = (await context.cookies()).find((c) => c.name === 'shikoo_session');
  expect(cookie).toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.path).toBe('/');
});
