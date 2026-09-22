/**
 * `allocate` — a cost split over services must add back to the cost, to the
 * Rial, or the profit screen invents or loses money in the rounding.
 */

import { describe, expect, it } from 'vitest';
import { allocate } from '../src/shopProfit.js';

describe('allocate', () => {
  it('splits by weight and hands the leftover Rial to the largest fraction', () => {
    // 1,000,001 × 3/4 = 750,000.75 and × 1/4 = 250,000.25: one Rial is left
    // after flooring, and .75 is the larger remainder.
    expect(allocate(1_000_001, [3_000_000, 1_000_000])).toEqual([750_001, 250_000]);
  });

  it('splits evenly when nothing sold, and ties go to the first', () => {
    expect(allocate(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it('keeps the sign of a negative total', () => {
    expect(allocate(-7, [1, 1])).toEqual([-4, -3]);
  });

  it('always sums back to the total', () => {
    for (const [total, weights] of [
      [1, [1, 1, 1]],
      [999_999_999, [7, 11, 13, 0]],
      [123_457, [1]],
      [0, [5, 5]],
    ] as const) {
      expect(allocate(total, [...weights]).reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(allocate(5, [])).toEqual([]);
  });
});
