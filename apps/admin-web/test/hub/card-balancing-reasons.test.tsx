/**
 * «چرا کارت من کار نمی‌کند» — answered in the language the panel is written in.
 *
 * The server sends the reason as a key: `account_deactivated`, `card_disabled`,
 * and since issue #86 `card_not_mapped`. This row printed the key verbatim, so
 * a Persian screen answered an operator's question with an English identifier
 * they cannot act on and would not think to search for.
 *
 * The second assertion is the one that matters more: a card the table no longer
 * has must still be LISTED with its money, because the money did not leave with
 * the card. Measured on staging, 2026-09-04: every settled Rial in that
 * environment sat on such a card, and this screen showed a total of zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { CardBalancingPanel } from '../../src/hub/cardAnalytics.js';

const WINDOWS = [
  { key: 'h12', hours: 12, label: '۱۲ ساعت' },
  { key: 'h24', hours: 24, label: '۲۴ ساعت' },
] as const;

function item(over: Record<string, unknown>) {
  return {
    cardDigits: '6037000000000095',
    cardMasked: '****0095',
    displayWeight: 1,
    accountId: 'acc-1',
    displayName: 'حساب ملی',
    ownerLabel: null,
    accountHint: '6006',
    accountStatus: 'ACTIVE',
    purchaseCount: 2,
    verifiedCount: 2,
    takingsIrr: 3_000_000,
    uniqueCustomers: 2,
    activity: { h12: 0, h24: 1 },
    cardStatus: 'ACTIVE',
    hubEligible: true,
    exclusionReason: 'hub_active',
    purchaseBarPercent: 100,
    ...over,
  };
}

const RESPONSE = {
  ok: true,
  range: 'all',
  entity: 'card_number',
  metric: 'hub_auto_verified_purchases',
  note: 'یادداشت',
  windows: WINDOWS,
  distribution: { min: 0, max: 2, gap: 2 },
  items: [
    item({}),
    item({
      cardDigits: '6104999988887777',
      cardMasked: '****7777',
      accountId: null,
      displayName: 'کارت نگاشت‌نشده',
      accountHint: null,
      accountStatus: 'UNMAPPED',
      cardStatus: 'UNMAPPED',
      purchaseCount: 0,
      verifiedCount: 1,
      takingsIrr: 5_000_000,
      uniqueCustomers: 1,
      activity: { h12: 0, h24: 0 },
      hubEligible: false,
      exclusionReason: 'card_not_mapped',
      purchaseBarPercent: 0,
    }),
    item({
      cardDigits: '5054161706275678',
      cardMasked: '****5678',
      hubEligible: false,
      exclusionReason: 'account_deactivated',
      purchaseCount: 0,
      takingsIrr: 0,
      verifiedCount: 0,
      uniqueCustomers: 0,
      purchaseBarPercent: 0,
    }),
  ],
};

beforeEach(() => {
  globalThis.fetch = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const draw = () =>
  render(<CardBalancingPanel cache={createCache()} rangeState={{ preset: 'all' }} />);

describe('the card balancing panel', () => {
  it('lists a card the table no longer has, with the money that went to it', async () => {
    draw();
    expect(await screen.findByText(/۵۰۰٬۰۰۰ تومان/)).toBeTruthy();
    // And it is not presented as something the bot might still use.
    expect((await screen.findAllByText('کنار گذاشته‌شده')).length).toBeGreaterThan(0);
  });

  /**
   * Seen on staging the moment the row went live: «****0037 · کارت نگاشت‌نشده ·
   * کارت نگاشت‌نشده». The label joins the card, the account hint and the owner,
   * and both of the last two fall back to `displayName` — which an unmapped
   * card has only one of. Two identical words with a dot between them read as
   * two facts.
   */
  it('does not say the same thing twice in one label', async () => {
    draw();
    const label = await screen.findByText(/\*\*\*\*7777/);
    const parts = label.textContent!.split('·').map((p) => p.trim());
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('says why in Persian, not in the API’s own words', async () => {
    draw();
    expect(
      await screen.findByText('این کارت دیگر در فهرست کارت‌ها نیست — پولش این‌جاست، خودش نه'),
    ).toBeTruthy();
    expect(await screen.findByText('حساب این کارت غیرفعال شده است')).toBeTruthy();
    // The keys themselves must not reach the screen.
    expect(screen.queryByText('card_not_mapped')).toBeNull();
    expect(screen.queryByText('account_deactivated')).toBeNull();
  });
});
