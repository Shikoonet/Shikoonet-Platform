/**
 * What «نمایندگان» draws, in the three states that are about money.
 *
 * The route tests assert the numbers; these assert that the SCREEN keeps apart
 * the pairs that look identical and mean opposite things:
 *
 *   - never metered  vs  metered at nothing
 *   - no cap         vs  a cap of zero
 *
 * The second is here because it was a real defect: the page divided by
 * `dataLimitBytes` after ruling out only `null`, so a cap of zero — a state
 * the adapter deliberately preserves — rendered as «NaN٪» or «Infinity٪».
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { ResellersPage } from '../src/pages/ResellersPage.js';
import type { ResellerRow } from '../src/api.js';

const GIB = 1024 ** 3;
const resellers = vi.fn();
const resellerReadings = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      resellers: () => resellers(),
      resellerReadings: (id: number) => resellerReadings(id),
    },
  };
});

function row(over: Partial<ResellerRow>): ResellerRow {
  return {
    id: 1,
    name: 'نمایندهٔ نمونه',
    status: 'ACTIVE',
    telegramId: '-1',
    username: 'agent',
    providerId: 1,
    providerName: 'پنل',
    panelAdminUsername: 'agent_admin',
    dataLimitBytes: 100 * GIB,
    expiresAt: null,
    installationUrl: null,
    note: null,
    billableBytes: 50 * GIB,
    latestUsedBytes: 50 * GIB,
    latestTotalUsers: 7,
    latestPanelStatus: 'active',
    latestPanelIsLimited: false,
    lastReadAt: '2026-09-07T09:00:00Z',
    readings: 1,
    ...over,
  };
}

function draw(items: ResellerRow[]) {
  resellers.mockResolvedValue({ ok: true, items });
  render(
    <RoleProvider role="ADMIN">
      <ResellersPage />
    </RoleProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resellerReadings.mockResolvedValue({ ok: true, items: [] });
});

describe('the two pairs that look the same and are not', () => {
  it('says «هنوز خوانده نشده» rather than a zero', async () => {
    // A franchise nobody has metered and one that used nothing are the same
    // number on an invoice and opposite facts. Only the first can be null.
    draw([row({ billableBytes: null, latestUsedBytes: null, lastReadAt: null, readings: 0 })]);

    await waitFor(() => expect(screen.getByText('هنوز خوانده نشده')).toBeTruthy());
    // Anchored: an unanchored «۰ گیگ» also matches «۱۰۰ گیگ», which is how a
    // test can pass for a reason it did not mean.
    expect(screen.queryByText(/^۰ گیگ$/)).toBeNull();
    // And the capacity cell says what was BOUGHT, with no usage figure beside
    // it, because there is no reading to put there.
    expect(screen.getByText('۱۰۰ گیگ خریده')).toBeTruthy();
  });

  it('draws no percentage for an unlimited reseller', async () => {
    draw([row({ dataLimitBytes: null })]);

    await waitFor(() => expect(screen.getByText('نامحدود')).toBeTruthy());
  });

  it('does not divide by a cap of zero', async () => {
    /**
     * The defect this test exists for. `data_limit: 0` is what the panel
     * reports for an admin allowed to use nothing — a real state the adapter
     * refuses to collapse into `null` — and the page used to divide by it.
     * `NaN٪` and `Infinity٪` are both worse than a sentence.
     */
    draw([row({ dataLimitBytes: 0, billableBytes: 3 * GIB })]);

    await waitFor(() => expect(screen.getByText(/با سقف صفر/)).toBeTruthy());
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });

  it('says so plainly when a zero cap has been used against by nothing', async () => {
    draw([row({ dataLimitBytes: 0, billableBytes: 0, latestUsedBytes: 0 })]);

    await waitFor(() => expect(screen.getByText('سقف صفر')).toBeTruthy());
  });

  it('shows the billable total even when the panel counter was reset', async () => {
    // `used` back at nothing, lifetime carrying on: the bill must not shrink.
    draw([row({ billableBytes: 249 * GIB, latestUsedBytes: 9 * GIB })]);

    await waitFor(() => expect(screen.getByText(/۲۴۹ گیگ از ۱۰۰ گیگ/)).toBeTruthy());
  });

  it('badges a franchise the panel stopped by itself', async () => {
    draw([row({ latestPanelIsLimited: true })]);

    await waitFor(() => expect(screen.getByText('به سقف رسیده')).toBeTruthy());
  });
});

describe('the boundary', () => {
  it('draws no customer of the reseller, only a count', async () => {
    // Their customers never reach this database, so the screen has nothing to
    // draw but a number. Asserted so a future column cannot quietly become a
    // list of somebody else's subscribers.
    draw([row({ latestTotalUsers: 7 })]);

    await waitFor(() => expect(screen.getByText('۷')).toBeTruthy());
    expect(screen.queryByRole('link', { name: /کاربر|مشتری/ })).toBeNull();
  });
});
