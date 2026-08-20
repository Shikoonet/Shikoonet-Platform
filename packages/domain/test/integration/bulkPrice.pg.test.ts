/**
 * Bulk repricing against a real Postgres.
 *
 * A fake database would prove nothing here. Everything that can go wrong in
 * this file is engine behaviour: whether a percentage divides as `numeric` or
 * floors as an integer, whether `round` goes to the nearest ten, whether the
 * `NOT EXISTS` guard is evaluated against the same snapshot as the UPDATE, and
 * whether `CHECK (price_irr >= 0)` aborts the batch. Faking any of it would be
 * asserting our own assumptions back at us.
 *
 * The numbers below are prices, so every assertion is a price rather than a
 * delta: an operator reads «۱۹۵٬۰۰۰ تومان», not «+۱۰٪».
 *
 * Needs DATABASE_URL and the migrations applied (`pnpm sim:up`).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { applyBulkPrice, previewBulkPrice, type BulkPriceChange } from '../../src/bulkPrice.js';

const { db, pool } = createPostgresD1();

/**
 * Everything this file created, removed.
 *
 * The catalog is shared. Leaving two panels and their plans behind made ten
 * tests fail in four other packages on 2026-08-20 — the bot's checkout, the
 * shop listing, and `seedCatalog`'s "shaped like production" count — none of
 * which is about pricing and all of which count what is for sale. A test that
 * adds to the catalog owes it a cleanup, and `beforeEach` alone does not: the
 * last one still stands when the file ends.
 */
async function cleanup(): Promise<void> {
  await db.prepare(`DELETE FROM product_plans WHERE name LIKE 'bp-%'`).run();
  await db.prepare(`DELETE FROM products WHERE code LIKE 'bp-%'`).run();
  await db
    .prepare(`DELETE FROM provisioning_providers WHERE code IN ('bp-panel-a', 'bp-panel-b')`)
    .run();
}

afterAll(async () => {
  await cleanup();
  await pool.end();
});

/** Two panels, so "this panel only" can be told from "everything". */
let panelA = 0;
let panelB = 0;

async function seed(prices: number[], other: number[] = []): Promise<void> {
  await cleanup();

  const mk = async (code: string): Promise<number> => {
    const row = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status)
         VALUES (?1, ?1, 'manual', 'ACTIVE') RETURNING id`,
      )
      .bind(code)
      .first<{ id: number }>();
    return row!.id;
  };
  panelA = await mk('bp-panel-a');
  panelB = await mk('bp-panel-b');

  const addPlans = async (providerId: number, tag: string, list: number[]): Promise<void> => {
    if (list.length === 0) return;
    const product = await db
      .prepare(
        `INSERT INTO products (code, name, kind, provider_id, status)
         VALUES (?1, ?1, 'vpn', ?2, 'ACTIVE') RETURNING id`,
      )
      .bind(`bp-${tag}`, providerId)
      .first<{ id: number }>();
    for (const [i, price] of list.entries()) {
      await db
        .prepare(
          `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
           VALUES (?1, ?2, ?3, 30, 'ACTIVE')`,
        )
        .bind(product!.id, `bp-${tag}-${i}`, price)
        .run();
    }
  };
  await addPlans(panelA, 'a', prices);
  await addPlans(panelB, 'b', other);
}

async function pricesOn(providerId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT pl.price_irr FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.provider_id = ?1 ORDER BY pl.name`,
    )
    .bind(providerId)
    .all<{ price_irr: number }>();
  return (results ?? []).map((r) => Number(r.price_irr));
}

const change = (over: Partial<BulkPriceChange>): BulkPriceChange => ({
  providerId: panelA,
  mode: 'FIXED',
  direction: 'UP',
  amount: 0,
  ...over,
});

beforeEach(async () => {
  // 10,000 / 50,000 / 195,000 Toman.
  await seed([100_000, 500_000, 1_950_000], [700_000]);
});

describe('a fixed change', () => {
  it('moves every plan on the panel by the same amount, and no other panel', async () => {
    const out = await applyBulkPrice(db, change({ amount: 50_000, direction: 'UP' }));

    expect(out).toEqual({ ok: true, changed: 3 });
    expect(await pricesOn(panelA)).toEqual([150_000, 550_000, 2_000_000]);
    // The other panel is untouched, which is the whole point of the scope.
    expect(await pricesOn(panelB)).toEqual([700_000]);
  });

  it('reaches every panel when no panel is named', async () => {
    // A null scope means EVERY plan in the database, and this database is
    // shared: the simulation catalogue the bot's own suites walk through lives
    // in it. The first version of this test repriced all of it and turned ten
    // tests red in two other packages — «۱۹۵٬۰۰۰ تومان» became «۱۹۷٬۰۰۰» and
    // `seedCatalog`'s "shaped like production" stopped being true.
    //
    // So it snapshots every price, applies, asserts, and puts them all back.
    // Asserting on a preview instead would have proved the SELECT and left the
    // UPDATE's scope — the half that writes — unproven.
    const { results: before } = await db
      .prepare(`SELECT id, price_irr FROM product_plans`)
      .all<{ id: number; price_irr: number }>();

    try {
      await applyBulkPrice(db, change({ providerId: null, amount: 10_000 }));
      expect(await pricesOn(panelA)).toEqual([110_000, 510_000, 1_960_000]);
      expect(await pricesOn(panelB)).toEqual([710_000]);
    } finally {
      // In a `finally`, because a failed assertion above must not be the
      // reason the next package's fixtures are wrong.
      for (const row of before ?? []) {
        await db
          .prepare(`UPDATE product_plans SET price_irr = ?2 WHERE id = ?1`)
          .bind(row.id, row.price_irr)
          .run();
      }
    }
  });

  it('subtracts on the way down', async () => {
    await applyBulkPrice(db, change({ amount: 50_000, direction: 'DOWN' }));
    expect(await pricesOn(panelA)).toEqual([50_000, 450_000, 1_900_000]);
  });
});

describe('a percentage', () => {
  it('is proportional, not flat', async () => {
    // 10% of three different prices is three different amounts. An integer
    // division would floor the cheapest one to nothing.
    await applyBulkPrice(db, change({ mode: 'PERCENT', amount: 10, direction: 'UP' }));
    expect(await pricesOn(panelA)).toEqual([110_000, 550_000, 2_145_000]);
  });

  it('works downward too, which the legacy never offered', async () => {
    await applyBulkPrice(db, change({ mode: 'PERCENT', amount: 10, direction: 'DOWN' }));
    expect(await pricesOn(panelA)).toEqual([90_000, 450_000, 1_755_000]);
  });

  it('lands on a whole Toman, never a fraction of one', async () => {
    // 3% of 100,000 IRR is 3,000; of 1,950,000 it is 58,500 — but 3% of a
    // price like 12,345 IRR is 370.35, which is not a number a customer can be
    // quoted or a bank SMS can match.
    await seed([12_345]);
    await applyBulkPrice(db, change({ mode: 'PERCENT', amount: 3, direction: 'UP' }));

    const [price] = await pricesOn(panelA);
    expect(price! % 10).toBe(0);
    // 12345 * 1.03 = 12715.35 → nearest ten.
    expect(price).toBe(12_720);
  });
});

describe('the floor the legacy did not have', () => {
  it('refuses the whole change rather than pricing anything below zero', async () => {
    const out = await applyBulkPrice(db, change({ amount: 600_000, direction: 'DOWN' }));

    expect(out).toEqual({ ok: false, reason: 'unsellable', plans: 2 });
    // Nothing moved — not even the one plan that could have absorbed it. A
    // half-applied price list is worse than a refused one.
    expect(await pricesOn(panelA)).toEqual([100_000, 500_000, 1_950_000]);
  });

  it('says so in the preview, before anything is pressed', async () => {
    const preview = await previewBulkPrice(db, change({ amount: 600_000, direction: 'DOWN' }));
    expect(preview.unsellable).toBe(2);
    expect(preview.plans).toBe(3);
  });

  it('refuses a price of exactly zero, which is not free but unsellable', async () => {
    // The floor tested `< 0` until 2026-08-21, so a decrease equal to the price
    // landed on zero and was written. `CHECK (price_irr >= 0)` is happy with it
    // and nothing else looked — and a zero-priced plan is not a giveaway, it is
    // a button that can never be pressed: `order.ts:221` refuses any order whose
    // total is not positive, so the plan stays listed and answers
    // ORDER_NOT_PAYABLE for ever. Silent, permanent, and invisible from here.
    await seed([50_000]);
    const out = await applyBulkPrice(db, change({ amount: 50_000, direction: 'DOWN' }));

    expect(out).toEqual({ ok: false, reason: 'unsellable', plans: 1 });
    expect(await pricesOn(panelA)).toEqual([50_000]);
  });

  it('does not refuse a rise because some plan was already free', async () => {
    // The catalogue really carries one: «اکانت تست - ۱ روزه - ۱ گیگ», priced 0
    // and ACTIVE, today. A floor written as a bare `next <= 0` counts it on
    // every single pass, so a ten per cent RISE is refused — a permanent lock
    // on the whole panel with no way out from the operator's screen, put there
    // by a fix for the opposite problem.
    //
    // The rule is what the CHANGE makes unsellable, so the guard is
    // `price_irr > 0 AND next <= 0`. The free plan is somebody's decision to
    // look at; it is not this function's to veto.
    await seed([0, 100_000]);
    const out = await applyBulkPrice(db, change({ mode: 'PERCENT', amount: 10, direction: 'UP' }));

    expect(out).toEqual({ ok: true, changed: 1 });
    // Zero times anything is still zero, so it did not move and was not counted.
    expect(await pricesOn(panelA)).toEqual([0, 110_000]);
  });

  it('refuses a decrease that only rounding takes to zero', async () => {
    // 50,004 - 50,000 = 4 IRR, which `round(x / 10) * 10` pulls to 0. Reaching
    // zero does not need an operator who typed the price exactly; anything
    // within five Rial of it does.
    await seed([50_004]);
    const out = await applyBulkPrice(db, change({ amount: 50_000, direction: 'DOWN' }));

    expect(out).toEqual({ ok: false, reason: 'unsellable', plans: 1 });
    expect(await pricesOn(panelA)).toEqual([50_004]);
  });
});

describe('the preview and the change agree', () => {
  it('predicts the exact total the apply produces', async () => {
    // The one assertion that matters. The preview is the only thing an
    // operator sees before committing, and it is worth nothing if it is
    // computed a second way.
    const c = change({ mode: 'PERCENT', amount: 7, direction: 'UP' });
    const preview = await previewBulkPrice(db, c);

    await applyBulkPrice(db, c);
    const after = (await pricesOn(panelA)).reduce((a, b) => a + b, 0);

    expect(preview.currentTotalIrr).toBe(2_550_000);
    expect(after).toBe(preview.newTotalIrr);
  });

  it('names real plans with their real before and after', async () => {
    const preview = await previewBulkPrice(db, change({ amount: 50_000 }));
    expect(preview.examples[0]).toEqual({
      name: 'bp-a-0',
      fromIrr: 100_000,
      toIrr: 150_000,
    });
  });

  it('shows both ends of the price list, not five copies of the cheap end', async () => {
    // The query was a single `ORDER BY price LIMIT 5` while the comment above it
    // promised the cheapest AND the dearest. Every example was the cheapest
    // five — which are also the rows a percentage is most likely to round to
    // nothing, so the sample was systematically the least representative one
    // available and was described as the most.
    await seed([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 9_000_000]);
    const preview = await previewBulkPrice(db, change({ amount: 10_000 }));

    const shown = preview.examples.map((x) => x.fromIrr);
    expect(shown).toContain(10_000);
    // The dearest plan is where a mistyped change does the most damage in Rial,
    // and it was the one row an operator could never see.
    expect(shown).toContain(9_000_000);
    expect(preview.examples).toHaveLength(5);
  });

  it('does not show one plan twice when the panel is smaller than the sample', async () => {
    await seed([10_000, 20_000]);
    const preview = await previewBulkPrice(db, change({ amount: 1_000 }));

    expect(preview.examples).toHaveLength(2);
    expect(new Set(preview.examples.map((x) => x.name)).size).toBe(2);
  });

  it('counts what will not move, rather than claiming it did', async () => {
    // 1% of 100,000 IRR is 1,000 — but 1% of 300 IRR is 3, which rounds back
    // to 300. Reporting "2 changed" when one of them did not is the kind of
    // small lie an operator has no way to check.
    await seed([300, 100_000]);
    const c = change({ mode: 'PERCENT', amount: 1, direction: 'UP' });

    const preview = await previewBulkPrice(db, c);
    expect(preview.unchanged).toBe(1);

    const out = await applyBulkPrice(db, c);
    expect(out).toEqual({ ok: true, changed: 1 });
  });

  it('tells "impossible" apart from "too small to matter"', async () => {
    await seed([300]);
    const out = await applyBulkPrice(db, change({ mode: 'PERCENT', amount: 1 }));
    expect(out).toEqual({ ok: false, reason: 'nothing_to_change' });
  });
});

describe('what is not for sale is not repriced', () => {
  it('leaves a disabled plan and a hidden product alone', async () => {
    await db
      .prepare(`UPDATE product_plans SET status = 'DISABLED' WHERE name = 'bp-a-0'`)
      .run();
    await applyBulkPrice(db, change({ amount: 50_000 }));

    // A price moved on something switched off is a surprise waiting for
    // whoever switches it back on.
    expect(await pricesOn(panelA)).toEqual([100_000, 550_000, 2_000_000]);
  });
});
