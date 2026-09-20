/**
 * A dialog inside the payments surface must sit above the panel's sidebar.
 *
 * Production, 2026-09-20: `.payments-shell__surface` had `z-index: 1`, which
 * made it a stacking context and clipped every fixed dialog inside it to z:1
 * — below the sidebar (1002). The decline and duplicate dialogs also used an
 * unstyled `.modal` class, so they stretched to the viewport and their
 * buttons landed under the sidebar, which swallowed the click. Two
 * assertions here, one per cause: the button takes its own click, and the
 * backdrop — not the sidebar — is what sits over the sidebar's area.
 */
import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

test('the duplicate dialog sits above the sidebar and its buttons take the click', async ({ page }) => {
  await page.setViewportSize({ width: 1523, height: 763 });
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  const now = Date.now();
  const raw = `e2e-modal-${now}`;
  const tx = `e2e-tx-${now}`;
  const dev = await db.prepare(`SELECT id FROM devices LIMIT 1`).first<{ id: string }>();
  const acct = await db.prepare(`SELECT id FROM financial_accounts WHERE active = 1 LIMIT 1`).first<{ id: string }>();
  await db.prepare(`INSERT INTO raw_sms_events (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at)
                    VALUES (?1, ?2, 'E2E', 'x', ?1, 'e2e', ?3, ?3, 'BANK_CREDIT', 'OK', ?3)`).bind(raw, dev!.id, now).run();
  await db.prepare(`INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr, balance_irr, bank_timestamp, confidence, parser_id, parser_version, status, financial_account_id, processing_disposition, created_at, updated_at)
                    VALUES (?1, ?2, 'CREDIT', 1200000, 5000000, ?3, 1, 'e2e', '1', 'PARSED', ?4, 'ACTIONABLE', ?3, ?3)`).bind(tx, raw, now, acct!.id).run();
  try {
    await page.goto('/admin/payments?tab=income');
    const row = page.locator('li.hub-list-row', { has: page.locator(`input[aria-label*="${tx}"]`) });
    await row.getByRole('button', { name: 'تکراری' }).click();
    const btn = page.getByRole('button', { name: 'تکراری است' });
    await expect(btn).toBeVisible();
    const hit = await btn.evaluate((b) => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === b || b.contains(el as Node); });
    expect(hit).toBe(true);
    const width = await page.locator('[role=dialog] .modal-body').evaluate((m) => m.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(560);
    // The backdrop covers the sidebar too: a click there closes the dialog
    // instead of opening a menu underneath it.
    const overSidebar = await page.locator('aside.app-sidebar').evaluate((a) => { const r = a.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.className ?? ''; });
    expect(overSidebar).toContain('modal-backdrop');
    await page.getByRole('button', { name: 'انصراف' }).click();
  } finally {
    await db.prepare(`DELETE FROM transaction_candidates WHERE id = ?1`).bind(tx).run();
    await db.prepare(`DELETE FROM raw_sms_events WHERE id = ?1`).bind(raw).run();
    await pool.end();
  }
});
