/**
 * دستگاه‌ها — the phones that carry every bank SMS, pressed.
 *
 * `POST /api/v1/sms` is the only public surface this platform has, and a
 * device token is what authorises it. Revoke one and that phone's messages
 * stop arriving: claims stop matching, and customers who have paid sit
 * unverified while the shop looks fine from every other screen.
 *
 * Walking this on 2026-08-22, «ابطال توکن» did exactly that on a single click
 * — no question, and no word afterwards. The row simply changed from a token
 * prefix to «ندارد». Every other press on this panel that takes something
 * away asks first, and this is the one with the longest reach and the least
 * reversible recovery: the replacement token is typed into the Android app by
 * hand, so undoing it needs the phone, not a second click.
 *
 * Both directions are asserted, and against the API rather than the row: a
 * dialog nobody can decline is decoration.
 */

import { expect, test } from '@playwright/test';

const fa = new Intl.NumberFormat('fa-IR');

/** The devices the seed makes, read from the API the screen reads. */
async function devices(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/v1/devices', { credentials: 'include' });
    return (await r.json()) as {
      items: Array<{
        id: string;
        display_name: string;
        credential: { token_prefix: string } | null;
      }>;
    };
  });
}

test('revoking a device token asks first, and declining changes nothing', async ({ page }) => {
  await page.goto('/admin/devices');
  await expect(page.locator('.sidebar-link.active')).toHaveText('دستگاه‌ها');

  const before = await devices(page);
  const target = before.items.find((d) => d.credential !== null);
  // The premise: a device with no token cannot demonstrate losing one.
  expect(target, 'the seed should give at least one device a credential').toBeTruthy();

  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });

  const row = page.locator(`tbody tr:has-text("${target!.display_name}")`);
  await row.getByRole('button', { name: 'ابطال توکن' }).click();
  await expect.poll(() => asked.length).toBe(1);

  // The question names the phone and what stops, rather than «مطمئنید؟». The
  // second sentence is the part an operator cannot work out from the button:
  // getting back in needs the handset.
  expect(asked[0]).toContain(target!.display_name);
  expect(asked[0]).toContain('پیامک بانکی');
  expect(asked[0]).toContain('واردکردن دستی');

  const after = await devices(page);
  const same = after.items.find((d) => d.id === target!.id);
  expect(same?.credential?.token_prefix).toBe(target!.credential!.token_prefix);
});

test('an accepted revoke takes the token and says what stopped', async ({ page }) => {
  await page.goto('/admin/devices');
  const before = await devices(page);
  const target = before.items.find((d) => d.credential !== null);
  expect(target).toBeTruthy();

  page.on('dialog', (d) => void d.accept());
  const row = page.locator(`tbody tr:has-text("${target!.display_name}")`);
  await row.getByRole('button', { name: 'ابطال توکن' }).click();

  // Said out loud. This view had a channel for failure and none for success,
  // so a press that worked and a press that did nothing looked identical.
  await expect(page.locator('#main-content [role="status"]')).toContainText('باطل شد');
  await expect(page.locator('#main-content [role="status"]')).toContainText(target!.display_name);

  const after = await devices(page);
  expect(after.items.find((d) => d.id === target!.id)?.credential).toBeNull();
});

test('the token itself is never printed in full', async ({ page }) => {
  await page.goto('/admin/devices');
  const list = await devices(page);
  const withToken = list.items.filter((d) => d.credential !== null);

  // A prefix is what the column shows, and the prefix is all the API sends —
  // the plaintext token exists exactly once, in the create modal, and is gone
  // from React state when it closes. Asserting the length keeps a future
  // "helpful" change from widening the prefix into the whole secret.
  for (const d of withToken) {
    expect(d.credential!.token_prefix.length).toBeLessThanOrEqual(8);
    await expect(page.locator(`tbody tr:has-text("${d.display_name}")`)).toContainText(
      `${d.credential!.token_prefix}…`,
    );
  }

  // And the count in the heading is the count of rows, in the panel's digits.
  await expect(page.locator('#main-content')).toContainText(`(${fa.format(list.items.length)})`);
});
