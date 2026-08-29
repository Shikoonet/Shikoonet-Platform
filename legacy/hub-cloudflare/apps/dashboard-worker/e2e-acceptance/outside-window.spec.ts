/**
 * BOUNDARY +61s — a transfer one second past the auto-verify window.
 * The engine must refuse to auto-verify it, but must still offer it to the
 * operator: refusing to decide is not the same as hiding the evidence.
 */
import { test, expect } from '@playwright/test';

test('a transfer 61s away is refused automatically but offered for manual approval', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible({
    timeout: 45_000,
  });

  const row = page.locator('.payment-row', { hasText: 'Order #fa02b0099d' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('outside the 5-minute auto-verify window');
  await page.screenshot({ path: 'acceptance-shots/61s-needs-review.png', fullPage: true });

  await row.getByRole('button', { name: 'Review' }).click();
  const drawer = page.getByRole('dialog', { name: 'Payment review' });
  await expect(drawer).toBeVisible();

  // The out-of-window transaction is shown with its delta, not hidden.
  await expect(drawer).toContainText('Δ 61 sec');
  const candidate = drawer.getByRole('radio');
  await expect(candidate).toHaveCount(1);

  // A lone candidate that failed only on timing is preselected (there is nothing
  // to disambiguate), but approving it still costs a deliberate click.
  await expect(candidate).toBeChecked();
  await expect(drawer.getByRole('button', { name: 'Approve selected' })).toBeEnabled();

  await page.screenshot({ path: 'acceptance-shots/61s-drawer.png' });
});
