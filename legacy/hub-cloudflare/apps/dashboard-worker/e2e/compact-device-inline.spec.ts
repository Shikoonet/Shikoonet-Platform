/**
 * Playwright E2E — at compact-desktop (1200px / 1280px), the originating
 * device must appear directly in every Today / Suggested / Unmatched /
 * Reviewed row, folded into the Account cell so we don't need to open
 * View Details.
 *
 * Asserts:
 *   - Each table has a compact / folded device present (no need to open
 *     View Details).
 *   - display_name ("Poyan Android Phone") is the primary text in the
 *     Account cell; device_code ("poyan-01") is the secondary.
 *   - No document overflow at either 1200px or 1280px.
 *   - No action button is clipped past its cell.
 *
 * Network responses are mocked so the test does not depend on D1 state.
 * Both Vite (5173) + wrangler (8787) come up via playwright.config.ts.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const POYAN_DISPLAY = 'Poyan Android Phone';
const POYAN_CODE = 'poyan-01';
const POYAN_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

function todayItem(id: string) {
  return {
    id,
    direction: 'CREDIT',
    amount_irr: 12_345_678,
    balance_irr: 123_456_789,
    status: 'PARSED',
    bank_timestamp: Date.now() - 60_000,
    effective_ts: Date.now() - 60_000,
    parser_id: 'parsian-signed-v1',
    financial_account_id: null,
    account_display: 'Parsian Hesab 1',
    account_hint: '300432401476',
    account_bank: 'PARS',
    device_id: POYAN_UUID,
    device_display_name: POYAN_DISPLAY,
    device_code: POYAN_CODE,
    sms_timestamp: Date.now() - 60_000,
    received_at: Date.now() - 60_000,
  };
}

function todayPayload() {
  return { ok: true, count: 1, items: [todayItem('t-1')] };
}

function suggestedItem(matchId: string, txId: string) {
  return {
    match: {
      id: matchId,
      transaction_candidate_id: txId,
      payment_claim_id: 'c-1',
      status: 'SUGGESTED',
      score: 0.92,
      matching_reasons: [],
      mismatch_reasons: [],
      reviewed_by: null,
      reviewed_at: null,
    },
    transaction: {
      id: txId,
      raw_sms_event_id: 'r-1',
      direction: 'CREDIT',
      amount_irr: 1_500_000,
      balance_irr: 12_345_000,
      status: 'PARSED',
      bank_timestamp: Date.now() - 60_000,
      financial_account_id: null,
      account_hint: null,
    },
    claim: {
      id: 'c-1',
      financial_account_id: null,
      expected_amount_irr: 1_500_000,
      expected_at: Date.now() - 120_000,
      status: 'PENDING',
    },
    account_display: 'Parsian Hesab 1',
    account_bank: 'PARS',
    device_id: POYAN_UUID,
    device_display_name: POYAN_DISPLAY,
    device_code: POYAN_CODE,
  };
}

function suggestedPayload() {
  return { ok: true, items: [suggestedItem('m-1', 't-1')] };
}

function unmatchedItem() {
  return {
    id: 'u-1',
    direction: 'CREDIT',
    amount_irr: 12_345_678,
    balance_irr: 123_456_789,
    status: 'NEEDS_REVIEW',
    bank_timestamp: Date.now() - 60_000,
    effective_ts: Date.now() - 60_000,
    parser_id: 'parsian-signed-v1',
    financial_account_id: null,
    account_display: 'Parsian Hesab 1',
    account_hint: '300432401476',
    account_bank: 'PARS',
    device_id: POYAN_UUID,
    sms_timestamp: Date.now() - 60_000,
    received_at: Date.now() - 60_000,
    device_display_name: POYAN_DISPLAY,
    device_code: POYAN_CODE,
    reason_no_match: [],
    eligible_claim_count: 0,
    warnings: [],
    detected_identifiers: [],
    review: null,
  };
}

function unmatchedPayload() {
  return { ok: true, items: [unmatchedItem()] };
}

function reviewedPayload() {
  return {
    ok: true,
    items: [
      {
        ...suggestedItem('mr-1', 'tr-1'),
        match: {
          id: 'mr-1',
          transaction_candidate_id: 'tr-1',
          payment_claim_id: 'c-1',
          status: 'CONFIRMED',
          score: 0.92,
          matching_reasons: [],
          mismatch_reasons: [],
          reviewed_by: 'admin@example.com',
          reviewed_at: Date.now() - 30_000,
        },
      },
    ],
  };
}

function reviewedTxPayload() {
  return {
    ok: true,
    items: [
      {
        id: 'tr-1',
        direction: 'CREDIT',
        amount_irr: 12_345_678,
        balance_irr: 123_456_789,
        status: 'PARSED',
        bank_timestamp: Date.now() - 60_000,
        sms_timestamp: Date.now() - 60_000,
        received_at: Date.now() - 60_000,
        financial_account_id: null,
        account_display: 'Parsian Hesab 1',
        account_bank: 'PARS',
        device_id: POYAN_UUID,
        device_display_name: POYAN_DISPLAY,
        device_code: POYAN_CODE,
        review: {
          id: 'r-1',
          decision: 'ACCEPTED',
          reason: null,
          comment: null,
          reviewed_by: 'admin@example.com',
          reviewer_role: 'ADMIN',
          reviewed_at: Date.now() - 30_000,
        },
      },
    ],
  };
}

async function mockAll(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/today')) return route.fulfill({ json: todayPayload() });
    if (url.includes('/api/v1/matches/suggested'))
      return route.fulfill({ json: suggestedPayload() });
    if (url.includes('/api/v1/matches/unmatched'))
      return route.fulfill({ json: unmatchedPayload() });
    if (url.includes('/api/v1/matches/reviewed/transactions'))
      return route.fulfill({ json: reviewedTxPayload() });
    if (url.includes('/api/v1/matches/reviewed')) return route.fulfill({ json: reviewedPayload() });
    if (url.includes('/api/v1/accounts')) return route.fulfill({ json: { ok: true, items: [] } });
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });
}

async function gotoTab(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  // Desktop uses top tabs (no drawer); click the named tab.
  await page.locator('.tabs .tab', { hasText: name }).first().click();
}

async function assertNoOverflow(page: Page, width: number) {
  const data = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  expect(
    data.scrollWidth,
    `viewport ${width}: scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}`,
  ).toBeLessThanOrEqual(data.clientWidth);
}

async function assertNoClippedButtons(page: Page, width: number) {
  const clipped = await page.evaluate(() => {
    const out: { cellText: string; btn: string; cellRight: number; btnRight: number }[] = [];
    const cells = Array.from(document.querySelectorAll('td.actions-cell'));
    for (const cell of cells) {
      const cellEl = cell as HTMLElement;
      const cellRect = cellEl.getBoundingClientRect();
      const btns = Array.from(cellEl.querySelectorAll('button'));
      for (const btn of btns) {
        const btnRect = btn.getBoundingClientRect();
        if (btnRect.right > cellRect.right + 0.5) {
          out.push({
            cellText: cellEl.parentElement?.textContent?.trim().slice(0, 30) ?? '',
            btn: btn.textContent?.trim().slice(0, 30) ?? '',
            cellRight: Math.round(cellRect.right),
            btnRight: Math.round(btnRect.right),
          });
        }
      }
    }
    return out;
  });
  expect(clipped, `clipped buttons at ${width}: ${JSON.stringify(clipped)}`).toEqual([]);
}

async function assertDeviceInAccountCell(
  page: Page,
  tableSelector: string,
  width: number,
  viewName: string,
) {
  // The device must be visible inside the Account cell WITHOUT opening View
  // Details — i.e. it's in the rendered DOM right now on this page.
  const table = page.locator(tableSelector).first();
  await table.waitFor({ timeout: 10_000 });
  // Account cell holds display_name + device_code as stacked metadata.
  const accountCells = table.locator('.account-cell');
  await expect(accountCells.first()).toBeVisible({ timeout: 10_000 });
  // display_name (primary) + device_code (secondary) both visible in cell.
  await expect(accountCells.first().getByText(POYAN_DISPLAY, { exact: false })).toBeVisible();
  await expect(accountCells.first().getByText(POYAN_CODE, { exact: false })).toBeVisible();
  // No internal UUID ever surfaces as a visible label.
  const html = await page.content();
  expect(
    html.includes(`>${POYAN_UUID}<`),
    `UUID exposed as a visible label in ${viewName} at ${width}px`,
  ).toBe(false);
}

for (const width of [1200, 1280]) {
  test(`Today: device visible inline in Account cell at ${width}px (no View Details needed)`, async ({
    page,
  }) => {
    await mockAll(page);
    await page.setViewportSize({ width, height: 800 });
    await gotoTab(page, 'Today');
    await assertNoOverflow(page, width);
    await assertDeviceInAccountCell(page, 'table.today-table--compact', width, 'Today');
    await assertNoClippedButtons(page, width);
  });

  test(`Suggested: device visible inline in Account cell at ${width}px`, async ({ page }) => {
    await mockAll(page);
    await page.setViewportSize({ width, height: 800 });
    await gotoTab(page, 'Matches');
    await page.locator('.tabs .tab', { hasText: 'Suggested' }).first().click();
    await assertNoOverflow(page, width);
    await assertDeviceInAccountCell(page, 'table.suggested-table--compact', width, 'Suggested');
    await assertNoClippedButtons(page, width);
  });

  test(`Unmatched: device visible inline in Account cell at ${width}px`, async ({ page }) => {
    await mockAll(page);
    await page.setViewportSize({ width, height: 800 });
    await gotoTab(page, 'Matches');
    await page.locator('.tabs .tab', { hasText: 'Unmatched' }).first().click();
    await assertNoOverflow(page, width);
    await assertDeviceInAccountCell(page, 'table.unmatched-table--compact', width, 'Unmatched');
    await assertNoClippedButtons(page, width);
  });

  test(`Reviewed matches: device visible inline in Account cell at ${width}px`, async ({
    page,
  }) => {
    await mockAll(page);
    await page.setViewportSize({ width, height: 800 });
    await gotoTab(page, 'Matches');
    await page.locator('.tabs .tab', { hasText: 'Reviewed' }).first().click();
    await assertNoOverflow(page, width);
    await assertDeviceInAccountCell(
      page,
      'table.reviewed-table--compact',
      width,
      'Reviewed matches',
    );
  });
}
