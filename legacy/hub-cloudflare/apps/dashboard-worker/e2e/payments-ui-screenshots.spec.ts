/**
 * Captures Shikoonet black + gold Payments UI screenshots with mocked API responses.
 * Run: cd apps/dashboard-worker && npx playwright test -c playwright.screenshots.config.ts
 */

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../dashboard-web/screenshots');

const ANALYTICS = {
  ok: true,
  range: 'all',
  sales: { amountIrr: 45_000_000, count: 32, amountChange: { kind: 'change', percent: 12 } },
  bankInflowIrr: 52_000_000,
  botAutoVerified: { count: 18, amountIrr: 28_500_000 },
  manualVerified: { count: 4, amountIrr: 6_200_000 },
  reseller: { count: 6, amountIrr: 10_300_000 },
  unassignedIncome: { count: 3, amountIrr: 4_100_000 },
  balances: { totalKnownIrr: 128_400_000, knownAccounts: 4, totalActiveAccounts: 5 },
  trend: [],
};

const ACCOUNT_ANALYTICS = {
  ok: true,
  items: [
    {
      accountId: 'a1',
      displayName: 'Melli Main',
      ownerLabel: 'Ops',
      accountHint: '6006',
      purchaseCount: 24,
      purchaseBarPercent: 100,
      currentBalanceIrr: 42_000_000,
    },
    {
      accountId: 'a2',
      displayName: 'Saderat Alt',
      ownerLabel: 'Backup',
      accountHint: '7007',
      purchaseCount: 11,
      purchaseBarPercent: 46,
      currentBalanceIrr: 18_500_000,
    },
  ],
};

const COUNTS = {
  needsReview: 2,
  needsReviewUnread: 1,
  waiting: 1,
  suspectedFake: 1,
  suspectedFakeUnread: 0,
  autoVerified: 5,
  botAutoVerified: 5,
  botAutoVerifiedUnread: 2,
  income: 3,
  incomeUnread: 1,
  manuallyVerified: 2,
  declinedIncome: 0,
  reseller: 2,
  resellerUnread: 0,
  all: 12,
};

function paymentItem(id: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    orderId: `ORD-${id}`,
    telegramUserId: '42',
    telegramUsername: 'ali',
    expectedAmountIrr: 1_950_000,
    expectedAmountToman: 195_000,
    cardMasked: '**** **** **** 5678',
    accountId: 'acc-1',
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    paidClickedAt: Date.now() - 120_000,
    receiptSubmittedAt: Date.now() - 60_000,
    createdAt: Date.now() - 120_000,
    effectiveTs: Date.now() - 60_000,
    reviewState: state,
    claimStatus: 'PENDING',
    matchStatus: state === 'BOT_AUTO_VERIFIED' ? 'MATCHED' : null,
    suspectReason:
      state === 'NEEDS_REVIEW'
        ? 'AMBIGUOUS_TRANSACTIONS'
        : state === 'SUSPECTED_FAKE'
          ? 'NO_TRANSACTION_AFTER_10M'
          : null,
    waitingRemainingMs: state === 'WAITING' ? 360_000 : null,
    waitingElapsedMs: null,
    timeDeltaMs: null,
    matchedTransaction:
      state === 'BOT_AUTO_VERIFIED'
        ? {
            id: 'tx-match-1',
            verifiedAt: Date.now() - 30_000,
            bankTimestamp: Date.now() - 45_000,
            amountIrr: 1_950_000,
            timeDeltaSeconds: 12,
          }
        : null,
    candidates: [],
    isNew: true,
    ...extra,
  };
}

function incomeItem(id: string) {
  return {
    id,
    amountIrr: 2_450_000,
    amountToman: 245_000,
    bankTimestamp: Date.now() - 90_000,
    accountId: 'acc-1',
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    reference: null,
    statusLabel: 'Unassigned income',
    isNew: id === 'tx-1',
  };
}

function resellerItem(id: string) {
  return {
    id,
    transactionId: id,
    resellerId: 'res-1',
    resellerName: 'Partner A',
    amountIrr: 3_200_000,
    amountToman: 320_000,
    bankTimestamp: Date.now() - 60_000,
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    reference: 'REF-001',
    classifiedBy: 'operator',
    classifiedAt: Date.now() - 60_000,
    note: null,
    isNew: false,
  };
}

function paymentsPayload(tab: string) {
  const itemsByTab: Record<string, unknown[]> = {
    needs_review: [paymentItem('nr1', 'NEEDS_REVIEW')],
    waiting: [paymentItem('w1', 'WAITING')],
    suspected_fake: [paymentItem('sf1', 'SUSPECTED_FAKE')],
    bot_auto_verified: [
      paymentItem('av1', 'BOT_AUTO_VERIFIED'),
      paymentItem('av2', 'BOT_AUTO_VERIFIED', { isNew: false, telegramUsername: 'sara' }),
    ],
    income: [incomeItem('tx-1'), incomeItem('tx-2')],
    manually_verified: [
      paymentItem('mv1', 'MANUALLY_VERIFIED', {
        reviewState: 'MANUALLY_VERIFIED',
        matchStatus: 'CONFIRMED',
        reopenEligible: true,
        matchedTransaction: {
          id: 'tx-mv1',
          verifiedAt: Date.now() - 3600_000,
          verifiedBy: 'admin@example.com',
          bankTimestamp: Date.now() - 3700_000,
          amountIrr: 1_950_000,
          timeDeltaSeconds: 18,
        },
        fulfillmentState: 'UNKNOWN',
      }),
    ],
    declined_income: [],
    reseller: [resellerItem('r1'), resellerItem('r2')],
    all: [paymentItem('all1', 'BOT_AUTO_VERIFIED')],
  };
  return {
    ok: true,
    tab,
    range: 'all',
    items: itemsByTab[tab] ?? [],
    counts: COUNTS,
    incomeTotals: { count: 3, amountIrr: 7_350_000 },
    resellerStats: { payments: 2, amountIrr: 6_400_000, activeResellers: 1, breakdown: [] },
    summary: {
      range: 'all',
      bankIncomeIrr: 52_000_000,
      botAutoVerified: { payments: 18, amountIrr: 28_500_000 },
      reseller: { payments: 6, amountIrr: 10_300_000, activeResellers: 2 },
      unassignedIncome: { count: 3, amountIrr: 4_100_000 },
    },
  };
}

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/analytics?')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(ANALYTICS) });
    }
    if (url.includes('/accounts/analytics')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(ACCOUNT_ANALYTICS),
      });
    }
    if (url.includes('/notifications/counts')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          counts: { unread: 3, incomeUnread: 1, botAutoVerifiedUnread: 2 },
        }),
      });
    }
    if (url.includes('/payments?')) {
      const tab = new URL(url).searchParams.get('tab') ?? 'income';
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(paymentsPayload(tab)),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });
}

async function setTheme(page: import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.addInitScript((mode) => {
    localStorage.setItem('shikoonet-theme', mode);
    document.documentElement.setAttribute('data-theme', mode);
  }, theme);
}

async function openPaymentsHub(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByText('SHIKOONET').waitFor();
  await page.getByRole('tablist', { name: 'Payment sections' }).waitFor();
}

function primaryOps(page: import('@playwright/test').Page) {
  return page.getByRole('tablist', { name: 'Payment sections' });
}

function reviewQueues(page: import('@playwright/test').Page) {
  return page.getByRole('tablist', { name: 'Review queues' });
}

test.describe('Shikoonet Payments UI screenshots', () => {
  test.beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
  });

  test('capture review and payments views', async ({ page }) => {
    test.setTimeout(120_000);
    await mockApi(page);
    await setTheme(page, 'dark');
    await openPaymentsHub(page);

    await reviewQueues(page).getByRole('tab', { name: /Income 3/i }).click();
    await page.getByText('Melli').first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'review-income-first.png'), fullPage: true });

    await reviewQueues(page).getByRole('tab', { name: /Bot Auto Verified 5/i }).click();
    await page.getByText('BOT VERIFIED').first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'target-match-bot-verified.png'), fullPage: true });
    await page.screenshot({ path: join(OUT_DIR, 'review-bot-auto-verified.png'), fullPage: true });

    await reviewQueues(page).getByRole('tab', { name: /Needs Review 2/i }).click();
    await page.getByText(/ORD-nr1/).first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'review-needs-review.png'), fullPage: true });

    await reviewQueues(page).getByRole('tab', { name: /Waiting 1/i }).click();
    await page.getByText(/ORD-w1/).first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'review-waiting.png'), fullPage: true });

    await reviewQueues(page).getByRole('tab', { name: /Suspected Fake 1/i }).click();
    await page.getByText(/ORD-sf1/).first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'review-suspected-fake.png'), fullPage: true });

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('tab=reseller') && r.ok()),
      primaryOps(page).getByRole('tab', { name: 'Reseller', exact: true }).click(),
    ]);
    await page.getByRole('button', { name: /Reseller payment from Partner A/i }).first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'reseller.png'), fullPage: true });

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('tab=manually_verified') && r.ok()),
      primaryOps(page).getByRole('tab', { name: 'Payments', exact: true }).click(),
    ]);
    await page.getByText(/ORD-mv1/).first().waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'payments-manually-verified.png'), fullPage: true });

    await page.getByRole('button', { name: 'Actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Reopen verification' }).click();
    await page.getByRole('dialog', { name: 'Reopen manual verification' }).waitFor();
    await page.screenshot({ path: join(OUT_DIR, 'reopen-confirmation.png'), fullPage: true });
  });
});
