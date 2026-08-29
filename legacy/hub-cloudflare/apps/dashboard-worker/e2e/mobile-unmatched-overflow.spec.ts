/**
 * Diagnostic spec for the Unmatched Incoming mobile-overflow bug.
 *
 * Loads the dashboard, switches to the Matches → Unmatched tab with a
 * realistic dataset (long identifiers, long device name, multiple warnings,
 * all five actions), and reports the actual element + CSS property that
 * pushes `document.documentElement.scrollWidth > clientWidth`.
 *
 * Run with the existing `pnpm test:e2e` harness; both web servers (Vite
 * :5173 + wrangler :8787) are brought up by playwright.config.ts.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const LONG_DEVICE = 'Poyan-iPhone-with-a-Very-Long-Display-Name-on-the-Backup-SIM';
const LONG_ID = 'IR30101883751600012345678901234567890-PARS1234567890-VeryLongAccountNumberInTest';
const LONG_WARNINGS = [
  'parser_warnings:AMBIGUOUS_CURRENCY',
  'no_account_assigned',
  'no_eligible_claim',
  'ACCOUNT_HINT_NOT_CONFIGURED',
  'extremely-long-warning-tag-just-to-stress-the-card-width-detector',
];

const MOCK_UNMATCHED = {
  ok: true,
  items: [
    {
      id: 'tx-long-1',
      direction: 'CREDIT',
      amount_irr: 12_345_678,
      balance_irr: 123_456_789,
      status: 'NEEDS_REVIEW',
      bank_timestamp: Date.now() - 30_000,
      effective_ts: Date.now() - 30_000,
      parser_id: 'parsian-signed-v1',
      confidence: 0.8,
      financial_account_id: null,
      account_display: null,
      account_hint: null,
      account_bank: 'PARS',
      device_id: 'dev-1',
      sms_timestamp: Date.now() - 30_000,
      received_at: Date.now() - 30_000,
      device_display_name: LONG_DEVICE,
      device_code: 'poyan-long-name-01',
      reason_no_match: LONG_WARNINGS,
      eligible_claim_count: 0,
      warnings: LONG_WARNINGS,
      detected_identifiers: [
        {
          type: 'ACCOUNT_NUMBER',
          normalized_value: LONG_ID,
          masked_value: `${LONG_ID.slice(0, 4)}…${LONG_ID.slice(-4)}`,
          parser_id: 'parsian-signed-v1',
          confidence: 0.9,
        },
        {
          type: 'CARD_LAST_FOUR',
          normalized_value: '1234',
          masked_value: '*1234',
          parser_id: 'parsian-signed-v1',
          confidence: 0.9,
        },
      ],
      review: null,
    },
  ],
};

const MOCK_ACCOUNTS = {
  ok: true,
  items: [
    {
      id: 'a-1',
      display_name: 'Melli Test Phone 1',
      bank_name: 'Melli',
      account_hint: '30101883751600',
      card_last_four: '1234',
      account_last_four: '5678',
      device_id: null,
      active: 1,
      parser_configuration: '{}',
      additional_identifiers: [],
    },
  ],
};

async function mockAll(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/matches/unmatched')) return route.fulfill({ json: MOCK_UNMATCHED });
    if (url.includes('/api/v1/accounts')) return route.fulfill({ json: MOCK_ACCOUNTS });
    // Return empty for anything else so the page is happy.
    return route.fulfill({ json: { ok: true, items: [], count: 0, matches: [] } });
  });
}

async function gotoUnmatched(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
  // Mobile renders the Drawer; if it's present, open it then click Matches.
  const drawer = page.getByRole('dialog', { name: 'Primary navigation' });
  if ((await drawer.count()) === 0) {
    const hamburger = page.locator('button.hamburger');
    if ((await hamburger.count()) > 0) await hamburger.first().click();
  }
  // Matches tab lives inside the drawer at mobile widths (role=tab).
  await page.getByRole('tab', { name: 'Matches' }).first().click();
  // The Unmatched tab is the default within MatchesView — click it.
  await page
    .getByRole('tab', { name: /Unmatched/ })
    .first()
    .click();
  // Wait for the card list / table to appear.
  await page
    .locator('[aria-label="Unmatched incoming transactions"], table.data-table')
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Walk the DOM at the current viewport and report the widest element
 * relative to `documentElement.clientWidth`. Used to find what *actually*
 * overflows, not what we assume overflows.
 */
async function findWidestOverflow(page: Page): Promise<{
  scrollWidth: number;
  clientWidth: number;
  widest: { selector: string; width: number; outerHTML: string }[];
}> {
  return await page.evaluate(() => {
    const doc = document.documentElement;
    const data = {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest: [] as Array<{ selector: string; width: number; outerHTML: string }>,
    };
    // Walk every element, find those whose bounding rect exceeds clientWidth.
    const all = document.body.querySelectorAll('*');
    const overflowing: Array<{ el: Element; w: number }> = [];
    for (const el of all) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right > doc.clientWidth + 0.5) {
        overflowing.push({ el, w: r.right });
      }
    }
    overflowing.sort((a, b) => b.w - a.w);
    for (const { el, w } of overflowing.slice(0, 8)) {
      const e = el as HTMLElement;
      const outerHTML = e.outerHTML.slice(0, 240);
      const className = (e.className && typeof e.className === 'string' ? e.className : '') || '';
      const tag = e.tagName.toLowerCase();
      const id = e.id ? `#${e.id}` : '';
      data.widest.push({
        selector: `${tag}${id}.${className.trim().split(/\s+/).slice(0, 3).join('.')}`,
        width: Math.round(w),
        outerHTML,
      });
    }
    return data;
  });
}

const WIDTHS = [320, 360, 390, 768, 1024, 1180, 1280, 1440, 1920];

for (const width of WIDTHS) {
  test(`diagnostic: report actual overflow at ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockAll(page);
    await gotoUnmatched(page);
    const data = await findWidestOverflow(page);
    // Always print so the diagnostic run leaves evidence.
    console.log(
      `viewport=${width} scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}`,
    );
    for (const w of data.widest) {
      console.log(`  overflow: ${w.selector} width=${w.width} html=${w.outerHTML.slice(0, 160)}`);
    }
    // The real assertion that matters:
    if (data.scrollWidth > data.clientWidth) {
      console.log(`  >>> OVERFLOW at ${width}px: ${data.scrollWidth} > ${data.clientWidth}`);
    } else {
      console.log(`  >>> OK at ${width}px`);
    }
  });
}

test('regression guard: scrollWidth <= clientWidth at mobile widths', async ({ page }) => {
  await mockAll(page);
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await gotoUnmatched(page);
    const data = await findWidestOverflow(page);
    expect(
      data.scrollWidth,
      `viewport ${width}: scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}; overflow=${JSON.stringify(data.widest)}`,
    ).toBeLessThanOrEqual(data.clientWidth);
  }
});

/**
 * Desktop assertions: the regression caused by the mobile fix at normal
 * desktop widths. At 1180 (tablet cards) and 1280 (compact desktop table)
 * we expect:
 *  - no <button> anywhere on the page is clipped
 *  - the Comments panel is NOT rendered inline (no `.split > .panel`)
 *    because at compact-desktop it must open as a right-side drawer
 *  - no document overflow (scrollWidth <= clientWidth)
 *
 * At 1280 we additionally assert the compact 6-column table is rendered
 * with nowrap headers and readable Amount/Account/Date/Status/Actions.
 *
 * At 1440/1920 we expect:
 *  - the Comments panel IS rendered inline (a `.panel` exists inside `.split`)
 *  - the full 11-column table is rendered with nowrap headers
 */
test('regression guard: compact-desktop (1180/1280) layout is usable', async ({ page }) => {
  await mockAll(page);
  for (const width of [1180, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await gotoUnmatched(page);

    // 1. No document overflow.
    const data = await findWidestOverflow(page);
    expect(
      data.scrollWidth,
      `viewport ${width}: scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}`,
    ).toBeLessThanOrEqual(data.clientWidth);

    // 2. No button inside .actions-cell clips past its cell.
    const buttonClipInfo = await page.evaluate(() => {
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
    expect(
      buttonClipInfo,
      `clipped buttons at ${width}px: ${JSON.stringify(buttonClipInfo)}`,
    ).toEqual([]);

    // 3. Comments panel must NOT be rendered inline as a side panel.
    const inlinePanelCount = await page.locator('.split > .panel').count();
    expect(inlinePanelCount, `inline Comments panel at ${width}px`).toBe(0);

    if (width >= 1200) {
      // 4. Compact 6-column table is rendered (compact-desktop only).
      const headerCount = await page.locator('table.unmatched-table--compact thead th').count();
      expect(headerCount, `compact table headers at ${width}px`).toBe(6);

      // 5. <th> elements must not break letter-by-letter.
      const thWrapInfo = await page.evaluate(() => {
        const ths = Array.from(document.querySelectorAll('table.unmatched-table--compact th'));
        return ths.map((th) => {
          const cs = window.getComputedStyle(th as HTMLElement);
          return {
            text: th.textContent?.trim().slice(0, 30) ?? '',
            whiteSpace: cs.whiteSpace,
          };
        });
      });
      for (const info of thWrapInfo) {
        expect(info.whiteSpace, `th "${info.text}" at ${width}px white-space`).toBe('nowrap');
      }

      // 6. Required columns are present: Amount, Account, Detected, Time, Status, Actions.
      // SortableHeader wraps the label in `.th-label`; the trailing sort
      // glyph (`↕`/`↑`/`↓`) lives in `.th-sort` and is excluded here so we
      // match the bare label rather than "amount↕".
      const headerTexts = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('table.unmatched-table--compact thead th .th-label'),
        ).map((el) => el.textContent?.trim().toLowerCase() ?? ''),
      );
      for (const required of ['amount', 'account', 'detected', 'sms time', 'status']) {
        expect(
          headerTexts.some((h) => h.includes(required)),
          `header "${required}" at ${width}px; got=${JSON.stringify(headerTexts)}`,
        ).toBe(true);
      }
      // Actions is a plain <th> with no .th-label wrapper.
      const actionsPresent = await page
        .locator('table.unmatched-table--compact thead th', { hasText: 'Actions' })
        .count();
      expect(actionsPresent, `header "actions" at ${width}px`).toBeGreaterThan(0);
    } else {
      // Tablet width — cards layout. Confirm no table is rendered.
      const tableCount = await page.locator('table.data-table').count();
      expect(tableCount, `data-table present at ${width}px (should be cards)`).toBe(0);
    }
  }
});

test('regression guard: wide-desktop (1440/1920) renders the full table beside Comments', async ({
  page,
}) => {
  await mockAll(page);
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await gotoUnmatched(page);

    // 1. No document overflow.
    const data = await findWidestOverflow(page);
    expect(
      data.scrollWidth,
      `viewport ${width}: scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}`,
    ).toBeLessThanOrEqual(data.clientWidth);

    // 2. No compact class on the wide-desktop table — the full 11-column one is used.
    const compactHeaderCount = await page
      .locator('table.unmatched-table--compact thead th')
      .count();
    expect(compactHeaderCount, `compact class active at ${width}px`).toBe(0);

    // 3. Full table has 11 headers.
    const fullHeaderCount = await page.locator('table.data-table thead th').count();
    expect(fullHeaderCount, `full table headers at ${width}px`).toBeGreaterThanOrEqual(11);

    // 4. Comments panel IS rendered inline.
    const inlinePanelCount = await page.locator('.split > .panel').count();
    expect(inlinePanelCount, `inline Comments panel at ${width}px`).toBe(1);

    // 5. Headers still nowrap on the full table.
    const whiteSpaces = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('table.data-table th'));
      return ths.map((th) => window.getComputedStyle(th as HTMLElement).whiteSpace);
    });
    for (const ws of whiteSpaces) {
      expect(ws, `th white-space at ${width}px`).toBe('nowrap');
    }
  }
});
