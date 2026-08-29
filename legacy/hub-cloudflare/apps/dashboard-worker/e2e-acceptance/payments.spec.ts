/**
 * Staging acceptance for the Payment Review inbox.
 *
 * Renders the real deployed bundle against the real payment-hub-staging D1.
 * Read-only: nothing here approves, rejects or mutates a claim.
 */
import { test, expect } from '@playwright/test';

const SHOTS = 'acceptance-shots';

async function openPaymentReview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  // Counts only appear once the first response lands; waiting on them keeps
  // every later assertion off the loading state.
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible();
}

test('Payment Review is a primary section and opens on Needs Review', async ({ page }) => {
  await openPaymentReview(page);

  const tabs = page.getByRole('tab');
  const labels = await tabs.allInnerTexts();
  const primary = labels.filter((l) => /^(Needs Review|Auto Verified|All) \(\d+\)$/.test(l));
  expect(primary).toHaveLength(3);
  expect(primary[0]).toMatch(/^Needs Review \(\d+\)$/);
  expect(primary[1]).toMatch(/^Auto Verified \(\d+\)$/);
  expect(primary[2]).toMatch(/^All \(\d+\)$/);

  // Default selection is Needs Review.
  await expect(page.getByRole('tab', { name: /^Needs Review/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // No primary tab for Waiting.
  expect(labels.some((l) => /waiting/i.test(l))).toBe(false);

  await page.screenshot({ path: `${SHOTS}/01-needs-review-default.png`, fullPage: true });
});

test('Today summary reports auto verified, need review and automation rate', async ({ page }) => {
  await openPaymentReview(page);
  const summary = page.locator('.payments-summary__stats');
  await expect(summary).toContainText('Auto verified');
  await expect(summary).toContainText('Need review');
  await expect(summary).toContainText('automated');
  await page.screenshot({ path: `${SHOTS}/02-today-summary.png` });
});

test('Auto Verified rows are read-only and show the matched transfer', async ({ page }) => {
  await openPaymentReview(page);
  await page.getByRole('tab', { name: /^Auto Verified/ }).click();

  const list = page.locator('.payment-list');
  const rows = list.getByRole('listitem');
  await expect(rows.first()).toBeVisible();

  await expect(rows.first()).toContainText('Automatically verified');
  await expect(rows.first()).toContainText(/Bank transfer/);
  await expect(rows.first()).toContainText(/Δ \d+ sec/);

  // No casual reversal affordances anywhere in the list.
  await expect(list.getByRole('button', { name: /approve/i })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /reject/i })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /undo/i })).toHaveCount(0);
  await expect(rows.first().getByRole('button', { name: 'Details' })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/03-auto-verified.png`, fullPage: true });
});

test('All tab exposes history with status chips and filters', async ({ page }) => {
  await openPaymentReview(page);
  await page.getByRole('tab', { name: /^All/ }).click();

  const filters = page.locator('.payments-filters');
  for (const label of ['Status', 'Account', 'Reason', 'From', 'To']) {
    await expect(filters).toContainText(label);
  }

  const pills = page.locator('.payment-list .status-pill');
  await expect(pills.first()).toBeVisible();
  expect(await pills.count()).toBeGreaterThan(0);
  const texts = await pills.allInnerTexts();
  const allowed = new Set([
    'Auto verified',
    'Needs review',
    'Manually verified',
    'Waiting',
    'Rejected',
    'Expired',
  ]);
  for (const t of texts) expect(allowed.has(t.trim())).toBe(true);

  await page.screenshot({ path: `${SHOTS}/04-all-history.png`, fullPage: true });
});

test('no full 16-digit PAN is rendered anywhere in the list views', async ({ page }) => {
  await openPaymentReview(page);
  for (const tab of [/^Needs Review/, /^Auto Verified/, /^All/]) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(400);
    const body = (await page.locator('body').innerText()).replace(/[\s-]/g, '');
    expect(body).not.toMatch(/\d{16}/);
  }
});

test('Waiting status filter is reachable inside All, not as a tab', async ({ page }) => {
  await openPaymentReview(page);
  await page.getByRole('tab', { name: /^All/ }).click();
  const status = page.locator('.payments-filters select').first();
  const options = await status.locator('option').allInnerTexts();
  expect(options).toContain('Waiting');
  expect(options).toContain('Manually verified');
  expect(options).toContain('Rejected');
});
