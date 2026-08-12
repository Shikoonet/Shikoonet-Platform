import { describe, expect, it } from 'vitest';
import { formatToman, nameMentionsPrice, priceForUser } from '../src/money.js';

describe('formatToman', () => {
  it('renders IRR as the Toman the customer is quoted', () => {
    expect(formatToman(1_950_000)).toBe('195,000 تومان');
    expect(formatToman(1_000_000)).toBe('100,000 تومان');
    expect(formatToman(13_000_000)).toBe('1,300,000 تومان');
  });

  it('renders the free row', () => {
    expect(formatToman(0)).toBe('0 تومان');
  });

  it('agrees with the price printed in the legacy product names', () => {
    // Not a self-consistency check: these are the migrated rows, and the Toman
    // figure is spelled out in the product name the customer reads today.
    // '3ماهه-150گیگ-چند کاربر-750.000ت' migrated to 7_500_000 IRR.
    expect(formatToman(7_500_000)).toBe('750,000 تومان');
    // '🥇30گیگ - VIP ... 300.000ت'
    expect(formatToman(3_000_000)).toBe('300,000 تومان');
  });
});

describe('nameMentionsPrice', () => {
  it('recognises the price the legacy schema forced into the name', () => {
    // Real migrated names. The legacy `product` row had nowhere else to show a
    // price, so every one of them spells it out.
    expect(nameMentionsPrice('1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀', 1_950_000)).toBe(true);
    expect(nameMentionsPrice('6️⃣ 6ماهه-300گیگ-چند کاربر-1.300.000ت🚀', 13_000_000)).toBe(true);
    expect(nameMentionsPrice('نامحدود - تک لوکیشن - 250.000 تومان', 2_500_000)).toBe(true);
    expect(nameMentionsPrice('🥇30گیگ - VIP - بدون محدودیت یوزر و زمان 300.000ت', 3_000_000)).toBe(
      true,
    );
  });

  it('reads Persian digits', () => {
    expect(nameMentionsPrice('۱ماهه - ۵۰ گیگ - ۱۹۵٫۰۰۰ تومان', 1_950_000)).toBe(true);
  });

  it('says no when the name carries no price', () => {
    expect(nameMentionsPrice('۱ماهه - ۵۰ گیگ - چند کاربر', 1_950_000)).toBe(false);
    expect(nameMentionsPrice('اسپاتیفای - ۱ ماهه', 2_500_000)).toBe(false);
  });

  it('does not mistake a longer number for this one', () => {
    // A name quoting 1,000,000 is not quoting 100,000.
    expect(nameMentionsPrice('پک ویژه - 1.000.000ت', 1_000_000)).toBe(false);
    expect(nameMentionsPrice('پک ویژه - 1.000.000ت', 10_000_000)).toBe(true);
  });

  it('does not read a volume or a duration as a price', () => {
    // 50 Toman is not a price; 50 is the gigabytes. Without the floor this
    // matches and the button loses its price.
    expect(nameMentionsPrice('۱ماهه - ۵۰ گیگ - چند کاربر', 500)).toBe(false);
    expect(nameMentionsPrice('۱ماهه - ۳۰ روزه', 300)).toBe(false);
  });
});

describe('priceForUser', () => {
  it('charges the list price when there is no discount', () => {
    expect(priceForUser(1_950_000, 0)).toEqual({
      unitPriceIrr: 1_950_000,
      discountIrr: 0,
      totalIrr: 1_950_000,
    });
  });

  it('applies the standing discount eight production customers actually have', () => {
    expect(priceForUser(1_950_000, 15)).toEqual({
      unitPriceIrr: 1_950_000,
      discountIrr: 292_500,
      totalIrr: 1_657_500,
    });
    expect(priceForUser(1_000_000, 30)).toEqual({
      unitPriceIrr: 1_000_000,
      discountIrr: 300_000,
      totalIrr: 700_000,
    });
  });

  it('lets a 100 percent customer pay nothing', () => {
    // One production account is set to 100. It must reach zero, not a negative
    // or a rounding remainder.
    expect(priceForUser(9_000_000, 100)).toEqual({
      unitPriceIrr: 9_000_000,
      discountIrr: 9_000_000,
      totalIrr: 0,
    });
  });

  it('floors the discount to a whole Toman', () => {
    // 3.33% of 1,950,000 IRR is 64,935 — 6,493.5 Toman, a price nobody can pay.
    const price = priceForUser(1_950_000, 3.33);
    expect(price.discountIrr).toBe(64_930);
    expect(price.totalIrr).toBe(1_885_070);
    expect(price.totalIrr % 10).toBe(0);
  });

  it('keeps the three numbers in the relation the orders CHECK requires', () => {
    for (const percent of [0, 10, 15, 20, 30, 100]) {
      const p = priceForUser(1_950_000, percent);
      expect(p.totalIrr).toBe(p.unitPriceIrr * 1 - p.discountIrr);
      expect(p.totalIrr).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses a discount outside 0..100', () => {
    expect(() => priceForUser(1_000_000, 101)).toThrow();
    expect(() => priceForUser(1_000_000, -1)).toThrow();
    expect(() => priceForUser(1_000_000, Number.NaN)).toThrow();
  });

  it('refuses a price that is not an amount', () => {
    expect(() => priceForUser(-1, 0)).toThrow();
    expect(() => priceForUser(Number.NaN, 0)).toThrow();
  });
});
