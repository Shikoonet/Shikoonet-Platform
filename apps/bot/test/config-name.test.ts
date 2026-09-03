/**
 * The composed config name, asked of the thing that renders it.
 *
 * `configName` lives in `@shikoo/contracts` and is written by the dashboard.
 * What matters here is not what it produces but what the BOT does with it: the
 * button label is `priced(name, …)`, which appends the live price unless the
 * name already quotes it. A name that accidentally reads as its own price
 * silently drops the price off the button — and for a customer with a standing
 * discount, off the only place they would have seen the discounted figure.
 *
 * So the assertion is against `nameMentionsPrice` itself, not against a rule
 * about digits restated in this file. If the bot's idea of "this name mentions
 * a price" ever changes, this goes red where a hand-written regex would not.
 */

import { describe, expect, it } from 'vitest';
import { configName } from '@shikoo/contracts';
import { nameMentionsPrice } from '../src/money.js';
import { planMenu } from '../src/menu.js';
import type { CatalogPlan } from '../src/catalog.js';

describe('a composed config name, seen by the bot', () => {
  /**
   * Every shape the dashboard's form can produce, against every price the shop
   * can charge.
   *
   * The bounds are the real catalogue's, not arbitrary: the priciest thing this
   * shop has ever sold is 750,000 Toman, volumes run to a few hundred gigabytes
   * and durations to two years. `nameMentionsPrice` ignores anything under a
   * thousand Toman, so the only way a composed name could ever be read as a
   * price is a volume or duration in the thousands sitting beside a price of
   * exactly that many Toman — outside this grid and outside the shop.
   */
  const VOLUMES = [null, 0, 1, 10, 20, 30, 50, 100, 150, 200, 500];
  const DAYS = [null, 1, 7, 14, 30, 60, 90, 180, 365, 360, 730];
  const USERS = [null, 1, 2, 3, 10];
  const PRICES_IRR = [1_000_0, 100_000_0, 119_000_0, 195_000_0, 750_000_0, 10_000_000_0];

  it('never reads as its own price, at any shape the form can make', () => {
    for (const volumeGb of VOLUMES) {
      for (const durationDays of DAYS) {
        for (const userLimit of USERS) {
          const name = configName({ volumeGb, durationDays, userLimit });
          for (const priceIrr of PRICES_IRR) {
            expect(
              nameMentionsPrice(name, priceIrr),
              `«${name}» was read as ${priceIrr} IRR`,
            ).toBe(false);
          }
        }
      }
    }
  });

  /** The real button, through the real menu builder — not the label helper alone. */
  function label(plan: Partial<CatalogPlan>, discountPercent = 0): string {
    const full: CatalogPlan = {
      planId: 1,
      productId: 1,
      productName: 'طلایی',
      planName: '',
      badge: null,
      buttonStyle: null,
      priceIrr: 0,
      durationDays: null,
      volumeGb: null,
      userLimit: null,
      providerId: 1,
      providerName: 'پنل تست',
      categoryId: 1,
      rowIndex: null,
      siblings: 2,
      tiers: 1,
      usernameMode: null,
      ...plan,
    };
    return planMenu([full], discountPercent)[0]![0]!.text;
  }

  it('gets the price appended on the button, discount included', () => {
    const shape = { volumeGb: 20, durationDays: 30, userLimit: null };
    const name = configName(shape);
    expect(name).toBe('۱ ماهه - ۲۰ گیگ - چند کاربر');

    // Exactly the shape Sam asked for — «۱ماهه-۲۰گیگ-چند کاربر-۱۱۹.۰۰۰ت» in the
    // legacy — except the price is the till's, so a discounted customer reads
    // what they will actually pay instead of the number frozen into the name.
    const plan = { ...shape, planName: name, priceIrr: 1_190_000 };
    expect(label(plan)).toBe(`${name} — 119,000 تومان`);
    expect(label(plan, 50)).toBe(`${name} — 59,500 تومان`);
  });
});
