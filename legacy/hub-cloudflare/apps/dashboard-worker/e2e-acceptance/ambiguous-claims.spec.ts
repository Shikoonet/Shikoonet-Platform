/**
 * ACCEPTANCE — two claims competing for one bank transfer.
 * Seeded by: source .staging-test.env && node scripts/acceptance-ambiguous-claims.mjs
 */
import { test, expect } from '@playwright/test';

const ORDER_A = 'acc-ambig-a-644a0b6d';
const ORDER_B = 'acc-ambig-b-1d313377';

test('two claims for one transfer both show AMBIGUOUS_CLAIMS and share the candidate', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible({
    timeout: 45_000,
  });

  for (const orderId of [ORDER_A, ORDER_B]) {
    const row = page.locator('.payment-row', { hasText: `Order #${orderId}` });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Multiple payments could match this bank transfer');
  }

  await page.locator('.payment-row', { hasText: `Order #${ORDER_A}` }).getByRole('button', { name: 'Review' }).click();
  const drawer = page.getByRole('dialog', { name: 'Payment review' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('radio')).toHaveCount(1);
  await expect(drawer.getByRole('button', { name: 'Approve selected' })).toBeDisabled();
});
