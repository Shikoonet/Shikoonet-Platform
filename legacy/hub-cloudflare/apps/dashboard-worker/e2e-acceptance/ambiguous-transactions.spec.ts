/**
 * ACCEPTANCE — two bank transfers match one claim inside the window.
 * The engine must refuse to pick and force the operator to choose.
 */
import { test, expect } from '@playwright/test';

test('two in-window transfers land as AMBIGUOUS_TRANSACTIONS with no preselection', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Payment Review' }).click();
  await expect(page.getByRole('tab', { name: /^Needs Review \(\d+\)$/ })).toBeVisible({
    timeout: 45_000,
  });

  const row = page.locator('.payment-row', { hasText: 'Order #f42e84d704' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Multiple bank transactions match this payment');

  await row.getByRole('button', { name: 'Review' }).click();
  const drawer = page.getByRole('dialog', { name: 'Payment review' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Δ 20 sec');
  await expect(drawer).toContainText('Δ 35 sec');

  const radios = drawer.getByRole('radio');
  await expect(radios).toHaveCount(2);
  for (const r of await radios.all()) {
    await expect(r).not.toBeChecked();
  }
  await expect(drawer.getByRole('button', { name: 'Approve selected' })).toBeDisabled();
});
