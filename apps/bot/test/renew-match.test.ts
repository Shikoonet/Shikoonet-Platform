/**
 * `matchingRenewalPlan`, rung by rung — and the rule that it never guesses.
 *
 * The DB tests in `renew.test.ts` cover the first two rungs through the real
 * screen. This file is the cheap place for the corners: the third rung (the
 * name it was sold under), a remembered plan that is no longer on offer, and
 * every «two fit» case answering null.
 */

import { describe, expect, it } from 'vitest';
import { matchingRenewalPlan } from '../src/renewMatch.js';
import type { CatalogPlan } from '../src/catalog.js';

function plan(over: Partial<CatalogPlan> & { planId: number }): CatalogPlan {
  return {
    productId: 1,
    productName: 'الماس',
    planName: '',
    priceIrr: 1_000_000,
    durationDays: 30,
    volumeGb: 50,
    userLimit: null,
    providerId: 9,
    providerName: 'پنل',
    categoryId: 1,
    siblings: 1,
    tiers: 1,
    usernameMode: 'GENERATED',
    badge: null,
    buttonStyle: null,
    rowIndex: null,
    ...over,
  } as CatalogPlan;
}

const sale = (over: Partial<Parameters<typeof matchingRenewalPlan>[0]>) => ({
  plan_id: null,
  plan_name_at_sale: '',
  volume_gb: null,
  duration_days: null,
  ...over,
});

describe('matchingRenewalPlan', () => {
  const twenty = plan({ planId: 1, volumeGb: 20, planName: '۲۰ گیگ' });
  const fiftyA = plan({ planId: 2, volumeGb: 50, planName: '۵۰ گیگ' });
  const fiftyB = plan({ planId: 3, volumeGb: 50, productName: 'طلایی', planName: '۵۰ گیگ' });
  const plans = [twenty, fiftyA, fiftyB];

  it('takes the remembered plan when it is still on offer', () => {
    expect(matchingRenewalPlan(sale({ plan_id: 3, volume_gb: 20, duration_days: 30 }), plans)).toBe(fiftyB);
  });

  it('falls through when the remembered plan is gone', () => {
    // 20 GB / 30 days fits exactly one, so the size rung answers.
    expect(matchingRenewalPlan(sale({ plan_id: 99, volume_gb: 20, duration_days: 30 }), plans)).toBe(twenty);
  });

  it('answers null when two plans share the size and length', () => {
    expect(matchingRenewalPlan(sale({ volume_gb: 50, duration_days: 30 }), plans)).toBeNull();
  });

  it('finds the plan by the name it was sold under, product and plan together', () => {
    expect(matchingRenewalPlan(sale({ plan_name_at_sale: 'طلایی — ۵۰ گیگ' }), plans)).toBe(fiftyB);
  });

  it('will not pick between two plans sold under the same bare name', () => {
    expect(matchingRenewalPlan(sale({ plan_name_at_sale: '۵۰ گیگ' }), plans)).toBeNull();
  });

  it('answers null for a migrated row that remembers nothing usable', () => {
    expect(matchingRenewalPlan(sale({ plan_name_at_sale: 'سرویس قدیمی' }), plans)).toBeNull();
    expect(matchingRenewalPlan(sale({}), [])).toBeNull();
  });
});
