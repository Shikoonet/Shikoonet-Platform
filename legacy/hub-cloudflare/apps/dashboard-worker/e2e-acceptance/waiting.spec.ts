/**
 * ACCEPTANCE CASE 8 — a claim still waiting for its bank transfer.
 * Read-only: opens the row's details and asserts it offers no decision.
 */
import { test, expect } from '@playwright/test';

test('a Waiting claim lives in All only, and is not actionable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  // The remote preview can cold-start into a multi-second first query.
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible({
    timeout: 45_000,
  });

  // Not in Needs Review.
  const needsReviewRows = page.locator('.payment-list .status-pill', { hasText: 'Waiting' });
  await expect(needsReviewRows).toHaveCount(0);

  // Not in Auto Verified.
  await page.getByRole('tab', { name: /^Auto Verified/ }).click();
  await expect(page.locator('.payment-list .status-pill', { hasText: 'Waiting' })).toHaveCount(0);

  // Present in All — if one is currently in flight. WAITING only exists inside a
  // claim's 10-minute waiting period, so against live data there may legitimately be none.
  await page.getByRole('tab', { name: /^All/ }).click();
  const waitingRow = page.locator('.payment-row', {
    has: page.locator('.status-pill', { hasText: 'Waiting' }),
  });
  const waitingCount = await waitingRow.count();
  test.skip(waitingCount === 0, 'no claim is currently inside its waiting period');
  await expect(waitingRow.first()).toBeVisible();
  await page.screenshot({ path: 'acceptance-shots/08-waiting-in-all.png', fullPage: true });

  // Details is read-only for a Waiting claim.
  await waitingRow.first().getByRole('button', { name: 'Details' }).click();
  const drawer = page.getByRole('dialog', { name: 'Payment review' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Waiting');
  await expect(drawer.getByRole('button', { name: 'Approve selected' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Reject payment' })).toHaveCount(0);
  await page.screenshot({ path: 'acceptance-shots/08-waiting-drawer.png' });
});
