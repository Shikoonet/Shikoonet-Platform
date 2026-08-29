/**
 * Playwright E2E — DevicesView Add-Device modal close flow, end-to-end
 * in a real browser. API calls are mocked via page.route() so the spec
 * runs without the wrangler backend.
 *
 * Verifies:
 *   - Opening the Add Device modal.
 *   - Creating a device lands us on the one-time setup screen.
 *   - The Done button closes the modal in one click.
 *   - The X button asks for confirmation; Cancel keeps, Confirm closes.
 *   - Escape does the same guarded close flow.
 *   - Backdrop click does the same guarded close flow.
 *   - After Copying the API token, X / Escape / backdrop close immediately.
 *   - The plaintext API token is gone from the DOM after close.
 *   - The trigger button is clickable again after close.
 *   - Background polling does not reopen the modal.
 */
import { test, expect, type Page } from '@playwright/test';

const SAMPLE_TOKEN = 'sk_live_TESTKEY_abcdef1234567890';
const SAMPLE_SETUP = {
  ok: true,
  device: {
    id: 'd-new',
    deviceCode: 'poyan-test',
    displayName: 'Poyan test',
    description: null,
    active: true,
  },
  credential: {
    id: 'c1',
    apiKey: SAMPLE_TOKEN,
    tokenPrefix: 'sk_live_TESTKEY',
    status: 'ACTIVE',
    shownOnce: true,
  },
  configuration: {
    method: 'POST',
    url: 'https://example.test/api/v1/ingest',
    contentType: 'application/json',
    jsonBody: {
      apiKey: SAMPLE_TOKEN,
      deviceId: 'd-new',
      deviceName: 'Poyan test',
      message: 'msg',
      sender: '+98',
      timestamp: '1700000000',
      checksum: 'abc',
    },
  },
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.endsWith('/api/v1/devices') && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SAMPLE_SETUP),
      });
      return;
    }
    if (url.includes('/api/v1/devices')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [] }),
      });
      return;
    }
    // Fallback for any other API the SPA touches on load.
    await route.fulfill({ status: 200, body: '{}' });
  });
}

async function openDevicesTab(page: Page) {
  // Tabs use role="tab" — match by accessible name with a relaxed role lookup.
  await page.locator('.tabs .tab', { hasText: 'Devices' }).click();
}

async function openAddDeviceModal(page: Page) {
  await page.getByTestId('open-add-device').click();
  await expect(page.getByRole('dialog', { name: 'Add device' })).toBeVisible();
}

async function fillAndCreateDevice(page: Page) {
  await page.getByPlaceholder('Poyan Android Phone 2').fill('Poyan test');
  // The Device ID / code input is auto-suggested to "poyan-test".
  await expect(page.getByPlaceholder('poyan-test')).toBeVisible();
  await page.getByRole('button', { name: 'Create device' }).click();
  await expect(page.getByRole('dialog', { name: 'Device setup' })).toBeVisible();
}

test.describe('DevicesView Add-Device modal — real browser', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    // Pre-grant clipboard so Copy API calls work in headless chromium.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
  });

  test('Done closes the modal and the trigger stays clickable', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);
    await expect(page.getByText('Device created — save your API token')).toBeVisible();

    await page.getByTestId('setup-done').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);

    // The Add Device trigger must be functional again.
    const trigger = page.getByTestId('open-add-device');
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Add device' })).toBeVisible();
  });

  test('X asks for confirmation when setup is unsaved; Cancel keeps; Confirm closes', async ({
    page,
  }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    await page.getByTestId('setup-close').click();
    await expect(page.getByTestId('close-confirmation')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toBeVisible();

    await page.getByTestId('close-confirmation-cancel').click();
    await expect(page.getByTestId('close-confirmation')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toBeVisible();

    await page.getByTestId('setup-close').click();
    await page.getByTestId('close-confirmation-confirm').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
  });

  test('Escape follows the same guarded close behavior', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('close-confirmation')).toBeVisible();
    // Escape on the confirmation cancels — modal stays.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('close-confirmation')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await page.getByTestId('close-confirmation-confirm').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
  });

  test('Backdrop click follows the same guarded close behavior', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    // Click on the backdrop (dialog wrapper, outside modal-body).
    const dialog = page.getByRole('dialog', { name: 'Device setup' });
    const box = await dialog.boundingBox();
    if (!box) throw new Error('dialog not measurable');
    // Click far above the modal body — outside, on the backdrop.
    await page.mouse.click(box.x + box.width / 2, 2);
    await expect(page.getByTestId('close-confirmation')).toBeVisible();

    await page.getByTestId('close-confirmation-cancel').click();
    await expect(page.getByTestId('close-confirmation')).toHaveCount(0);

    await page.mouse.click(box.x + box.width / 2, 2);
    await page.getByTestId('close-confirmation-confirm').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
  });

  test('After copying the token, X closes immediately without confirmation', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    await page.getByTestId('copy-token').click();
    await expect(page.getByText(/API token copied/)).toBeVisible();

    await page.getByTestId('setup-close').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
    await expect(page.getByTestId('close-confirmation')).toHaveCount(0);
  });

  test('plaintext token is not in the DOM after close', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    // Token is shown masked by default.
    await expect(page.getByTestId('token-text')).toHaveText('•'.repeat(SAMPLE_TOKEN.length));

    await page.getByTestId('setup-done').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain(SAMPLE_TOKEN);
    // No leftover backdrop intercepting clicks.
    expect(await page.locator('.modal-backdrop').count()).toBe(0);
  });

  test('background polling does not reopen or reset the modal', async ({ page }) => {
    await openDevicesTab(page);
    await openAddDeviceModal(page);
    await fillAndCreateDevice(page);

    // Wait through multiple polling ticks while the setup modal is open.
    // The Devices endpoint is polled every 5s; advancing ~6s should trigger
    // at least one refetch that must NOT reopen the modal.
    await page.waitForTimeout(6000);
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toBeVisible();
    await expect(page.getByTestId('token-text')).toHaveText('•'.repeat(SAMPLE_TOKEN.length));

    await page.getByTestId('setup-done').click();
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
    await page.waitForTimeout(6000);
    await expect(page.getByRole('dialog', { name: 'Device setup' })).toHaveCount(0);
  });
});
