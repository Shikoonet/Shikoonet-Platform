/**
 * ACCEPTANCE — a claim whose card maps to no bank account.
 * The engine stops at card resolution, so the operator gets a plain-language
 * reason and no transaction to approve against.
 */
import { test, expect } from '@playwright/test';

test('an unmapped card lands in Needs Review with a readable reason', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible({
    timeout: 45_000,
  });

  const row = page.locator('.payment-row', { hasText: 'Order #d90e33144d' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Card is not linked to a bank account');
  await expect(row).toContainText('Unmapped account');
  await expect(row).toContainText('**** **** **** 4006');
  await page.screenshot({ path: 'acceptance-shots/unmapped-card-row.png', fullPage: true });

  // Nothing to approve against: the reviewer can only reject.
  await row.getByRole('button', { name: 'Review' }).click();
  const drawer = page.getByRole('dialog', { name: 'Payment review' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('radio')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Approve selected' })).toBeDisabled();
  await page.screenshot({ path: 'acceptance-shots/unmapped-card-drawer.png' });
});
