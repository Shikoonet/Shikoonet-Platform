/**
 * رویدادها — the screen that replaced `psql` over SSH.
 *
 * `app_events` filled from 2026-08-22 and had exactly one reader: a person with
 * the server key. This page exists so the shop's owner can find the failure,
 * press «کپی» and paste it to whoever is debugging — so the assertion that
 * matters most here is not that a table renders, it is **what actually lands on
 * the clipboard**. Everything else on this screen is a way of getting to that
 * one press.
 *
 * The clipboard is therefore read back through `navigator.clipboard.readText()`
 * rather than inferred from the button saying «کپی شد». A button can say that
 * and copy an empty string — which is precisely what an unselected textarea
 * does, and why the fallback in `clipboard.ts` is written the way it is.
 *
 * Fixtures are inserted straight into `app_events` and removed afterwards. The
 * table is append-only in practice but not by trigger — `audit_logs` has the
 * trigger, this one is prunable on purpose — so cleanup is possible and is done.
 */

import { expect, test } from '@playwright/test';
import { createPostgresD1 } from '@shikoo/db';

const SVC = 'e2e-events';
const TRACE = 'u77000123';
const REF = 'ORD-E2E-77';
const STACK_LINE = 'at provisionPaidOrders (provision.ts:264:11)';

async function withDb<T>(fn: (d: ReturnType<typeof createPostgresD1>['db']) => Promise<T>) {
  const { db, pool } = createPostgresD1({ connectionString: process.env['DATABASE_URL']! });
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const wipe = () =>
  withDb((d) => d.prepare(`DELETE FROM app_events WHERE svc = ?1`).bind(SVC).run());

test.beforeEach(async ({ context }) => {
  await wipe();
  await withDb(async (d) => {
    await d
      .prepare(
        `INSERT INTO app_events (level, svc, evt, trace, ref, fields, err)
         VALUES ('error', ?1, 'provision.failed', ?2, ?3, ?4::jsonb, ?5)`,
      )
      .bind(
        SVC,
        TRACE,
        REF,
        JSON.stringify({ kind: 'pasarguard', apiKey: '[redacted]' }),
        JSON.stringify({
          name: 'Error',
          message: 'panel refused: 502',
          stack: `Error: panel refused: 502\n    ${STACK_LINE}`,
        }),
      )
      .run();
    // A second row on the same trace, so «همهٔ این ردیابی» has something to
    // find, and a third that shares nothing — a filter that returned
    // everything would otherwise pass.
    await d
      .prepare(
        `INSERT INTO app_events (level, svc, evt, trace, fields)
         VALUES ('warn', ?1, 'provision.will_retry', ?2, '{}'::jsonb),
                ('warn', ?1, 'sync.panel_skipped', NULL, '{}'::jsonb)`,
      )
      .bind(SVC, TRACE)
      .run();
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test.afterAll(wipe);

async function openSection(page: import('@playwright/test').Page) {
  await page.goto('/admin/events');
  await expect(page.locator('.sidebar-link.active')).toHaveText('رویدادها');
  // The first render has to arrive before anything is typed into the filters,
  // or the press lands on a form React has not attached a handler to yet and
  // the assertion below reads the unfiltered page as a result.
  await expect(page.locator('tbody tr').first()).toBeVisible();
}

/** Narrows to this file's rows through the search box, the way an admin does. */
async function open(page: import('@playwright/test').Page, q = REF) {
  await openSection(page);
  await page.locator('#event-q').fill(q);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`q=${encodeURIComponent(q)}`)),
    page.getByRole('button', { name: 'جست‌وجو' }).click(),
  ]);
}

/**
 * Narrows through the service dropdown instead.
 *
 * Not through the search box: `q` matches the event name, the ref, the trace,
 * the error text and the fields — and deliberately not `svc`, which has a
 * filter of its own. The first version of this file typed the service name into
 * the search box and got an empty table, which is the route behaving correctly.
 */
async function openService(page: import('@playwright/test').Page, svc = SVC) {
  await openSection(page);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`svc=${encodeURIComponent(svc)}`)),
    page.locator('#event-svc').selectOption(svc),
  ]);
}

test('the section shows what the process wrote, and finds it by the order id', async ({ page }) => {
  await open(page);

  const row = page.locator('tbody tr', { hasText: 'provision.failed' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('خطا');
  await expect(row).toContainText(REF);
  // Searching by the order id is the whole point: an admin has «سفارش ORD-…»
  // in front of them and no idea what the event is called.
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('the stack is on the screen, not only in the clipboard', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'جزئیات' }).click();

  const detail = page.locator('.event-detail');
  await expect(detail).toContainText('panel refused: 502');
  await expect(detail).toContainText(STACK_LINE);
  // The redaction that happened at write time is visible as what it is, rather
  // than as a missing field somebody would ask about.
  await expect(detail).toContainText('[redacted]');
});

test('copying one event puts the event on the clipboard, as JSON', async ({ page }) => {
  await open(page);
  await page
    .locator('tbody tr', { hasText: 'provision.failed' })
    .getByRole('button', { name: 'کپی' })
    .click();
  await expect(page.getByRole('button', { name: 'کپی شد ✓' })).toBeVisible();

  const text = await page.evaluate(() => navigator.clipboard.readText());
  // Parsed, not string-matched: the promise this button makes is that what is
  // pasted is machine-readable on the other end.
  const copied = JSON.parse(text) as {
    evt: string;
    ref: string;
    trace: string;
    fields: Record<string, string>;
    err: { message: string; stack: string };
  };
  expect(copied.evt).toBe('provision.failed');
  expect(copied.ref).toBe(REF);
  expect(copied.trace).toBe(TRACE);
  expect(copied.fields.kind).toBe('pasarguard');
  // The stack arrives as real newlines inside a JSON string rather than as the
  // escaped one-liner Postgres stores, which is the difference between a
  // readable paste and a wall of `\n`.
  expect(copied.err.stack).toContain(STACK_LINE);
  expect(copied.err.message).toBe('panel refused: 502');
});

test('the page copy button copies every row that is shown, and only those', async ({ page }) => {
  await openService(page);

  await page.getByRole('button', { name: /^کپی ۳ ردیف این صفحه$/ }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as Array<{
    evt: string;
  }>;
  expect(copied.map((e) => e.evt).sort()).toEqual([
    'provision.failed',
    'provision.will_retry',
    'sync.panel_skipped',
  ]);
});

test('one trace collects the events that belong to a single update', async ({ page }) => {
  await openService(page);

  await page.getByRole('button', { name: TRACE }).first().click();
  await expect(page.locator('#main-content .alert-info')).toContainText(TRACE);

  // Two of the three fixtures share the trace. The third is the control: a
  // «filter» that changed the banner and not the rows would pass without it.
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('tbody')).not.toContainText('sync.panel_skipped');
});

test('the level filter is applied by the server, not by hiding rows', async ({ page }) => {
  await openService(page);
  await page.locator('#event-level').selectOption('error');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  // Read off the head line, which is computed from the same query as the rows —
  // a client-side hide would leave it saying three.
  await expect(page.locator('.page-head__sub')).toContainText('۱ رویداد');
});
